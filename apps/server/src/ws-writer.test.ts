import { describe, expect, it } from 'vitest'
import { WebSocketEventWriter } from './ws-writer.js'

describe('WebSocketEventWriter', () => {
  it('waits for a slow socket to drain before resolving writes', async () => {
    let bufferedAmount = 0
    const sent: string[] = []
    const socket = {
      get bufferedAmount() {
        return bufferedAmount
      },
      send(value: string) {
        sent.push(value)
        bufferedAmount = 1
        setTimeout(() => {
          bufferedAmount = 0
        }, 25)
      },
      close() {},
    }
    const writer = new WebSocketEventWriter(socket, () => {
      throw new Error('unexpected overflow')
    })

    const started = performance.now()
    await expect(writer.write('slow')).resolves.toBe(true)
    expect(performance.now() - started).toBeGreaterThanOrEqual(20)
    expect(sent).toEqual(['slow'])
    writer.close()
  })

  it('closes on a full queue for cursor-based reconnect', async () => {
    let bufferedAmount = 1
    let overflowed = false
    let closed = false
    const socket = {
      get bufferedAmount() {
        return bufferedAmount
      },
      send(_value: string) {},
      close() {
        closed = true
        bufferedAmount = 0
      },
    }
    const writer = new WebSocketEventWriter(
      socket,
      () => {
        overflowed = true
        socket.close()
      },
      2,
    )

    const first = writer.write('first')
    const second = writer.write('second')
    const third = writer.write('third')
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      false,
      false,
      false,
    ])
    expect(overflowed).toBe(true)
    expect(closed).toBe(true)
  })
})

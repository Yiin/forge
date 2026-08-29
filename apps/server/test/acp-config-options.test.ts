import { describe, expect, it } from 'vitest'
import {
  createConfigOptionChannel,
  type SessionConfigOption,
} from '../src/acp/configOptions.js'

const option: SessionConfigOption = {
  id: 'thought_level',
  name: 'Thought level',
  type: 'select',
  currentValue: 'high',
  options: [{ value: 'high', name: 'High' }],
  category: 'thought_level',
}

function harness() {
  let push!: (value: any) => void
  const writes: any[] = []
  const readable = new ReadableStream<any>({
    start(controller) {
      push = controller.enqueue.bind(controller)
    },
  })
  const writable = new WritableStream<any>({
    write(value) {
      writes.push(value)
    },
  })
  return { base: { readable, writable }, push, writes }
}

describe('ACP config option channel', () => {
  it('handles raw config responses and filters config updates', async () => {
    const input = harness()
    const updates: SessionConfigOption[][] = []
    const channel = createConfigOptionChannel(input.base as never, {
      onConfigOptions: (_sessionId, values) => updates.push(values),
    })
    const reader = channel.stream.readable.getReader()
    const pending = channel.setConfigOption('session-1', option.id, 'high')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(input.writes[0]).toMatchObject({
      id: 'forge-cfg-0',
      method: 'session/set_config_option',
      params: { sessionId: 'session-1', configId: option.id, value: 'high' },
    })
    input.push({
      jsonrpc: '2.0',
      id: 'forge-cfg-0',
      result: { configOptions: [option] },
    })
    await expect(pending).resolves.toEqual([option])
    input.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: [option],
        },
      },
    })
    input.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: { sessionUpdate: 'agent_message_chunk' },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updates).toEqual([[option]])
    expect((await reader.read()).value).toMatchObject({
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk' } },
    })
  })

  it('rejects JSON-RPC errors', async () => {
    const input = harness()
    const channel = createConfigOptionChannel(input.base as never, {
      onConfigOptions() {},
    })
    const pending = channel.setConfigOption('session-1', 'mode', false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    input.push({
      jsonrpc: '2.0',
      id: 'forge-cfg-0',
      error: { code: -1, message: 'unsupported' },
    })
    await expect(pending).rejects.toThrow('unsupported')
  })
})

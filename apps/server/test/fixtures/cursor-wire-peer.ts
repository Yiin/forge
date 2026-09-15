import { closeSync } from 'node:fs'
import { cursorLimits } from '../../src/harnesses/cursor/limits.js'
import { cursorTransport } from '../../src/harnesses/cursor/wire.js'
const keepAlive = setInterval(() => {}, 1000)
if (process.argv[2] === 'blocked-output') {
  const transport = cursorTransport(
    process.stdout,
    process.stdin,
    'generation',
    cursorLimits({ queuedFrames: 3 }),
    () => {},
  )
  const owner = {
      forgeSessionId: 'session',
      provider: 'cursor',
      accountId: 'account',
      cwd: '/tmp',
      storeId: 'store',
      generation: 'generation',
      attemptId: 'attempt',
      runId: 'run',
      turnId: 'turn',
    },
    frame = {
      v: 1,
      generation: 'generation',
      type: 'native_record',
      owner,
      record: { text: 'x'.repeat(1024 * 1024) },
    }
  let settlements = 0
  const first = transport.send(frame).then(() => settlements++),
    second = transport.send(frame).then(() => settlements++)
  await transport.send(frame).then(
    () => {
      throw new Error('Third frame was admitted')
    },
    () =>
      process.stderr.write(
        `fixture:blocked:${transport.state.queuedFrames}:${transport.state.queuedBytes}\n`,
      ),
  )
  const diagnostic = transport
    .send({
      v: 1,
      generation: 'generation',
      type: 'failure',
      code: 'cursor_fixture_failure',
    })
    .then(() => settlements++)
  await transport
    .send({
      v: 1,
      generation: 'generation',
      type: 'failure',
      code: 'cursor_fixture_failure',
    })
    .then(
      () => {
        throw new Error('Second diagnostic was admitted')
      },
      () =>
        process.stderr.write(
          `fixture:diagnostic:${transport.state.queuedFrames}\n`,
        ),
    )
  await Promise.all([first, second, diagnostic])
  process.stderr.write(`fixture:settled:${settlements}\n`)
  await transport.close()
  clearInterval(keepAlive)
} else if (process.argv[2] === 'closed-input') {
  closeSync(0)
  process.stderr.write('fixture:closed-input\n')
} else if (process.argv[2] === 'blocked-input') {
  process.stdin.pause()
  process.stderr.write('fixture:blocked-input\n')
} else if (process.argv[2] === 'control-replies') {
  const transport = cursorTransport(
    process.stdout,
    process.stdin,
    'generation',
    cursorLimits(),
    (frame) => {
      const type = {
        models: 'models_result',
        close: 'closed',
        retire: 'retired',
        cancel: 'cancelled',
      }[frame.type]
      if (!type) throw new Error('Unknown fixture control')
      void transport.send({
        v: 1,
        generation: 'generation',
        requestId: frame.requestId,
        type,
        ...(type === 'models_result' ? { items: [] } : {}),
      })
    },
  )
  void transport.done.then(() => clearInterval(keepAlive))
} else throw new Error('Unknown wire fixture')

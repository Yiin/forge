// Synthetic app-server peer. No native provider, auth command, or network request runs.
import { readFileSync, appendFileSync, watch, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { isDeepStrictEqual } from 'node:util'
const script = JSON.parse(readFileSync(process.env.FORGE_CODEX_SCRIPT, 'utf8'))
const captured = JSON.parse(
  readFileSync(
    new URL('./schema-0.153.4/capture.json', import.meta.url),
    'utf8',
  ),
).schemas
const requestSchemas = {
  initialize: 'v1/InitializeParams.json',
  'thread/start': 'v2/ThreadStartParams.json',
  'thread/resume': 'v2/ThreadResumeParams.json',
  'turn/start': 'v2/TurnStartParams.json',
  'turn/steer': 'v2/TurnSteerParams.json',
  'thread/fork': 'v2/ThreadForkParams.json',
  'thread/turns/list': 'v2/ThreadTurnsListParams.json',
  'thread/items/list': 'v2/ThreadItemsListParams.json',
}
const trace = (value) =>
  appendFileSync(script.trace, JSON.stringify(value) + '\n')
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
const die = () => {
  trace({ failure: 'peer assertion' })
  process.exit(79)
}
if (process.argv.slice(-2).join(' ') !== 'app-server --stdio') die()
for (const key of script.absent ?? [])
  if (Object.hasOwn(process.env, key)) die()
for (const [key, value] of Object.entries(script.environment ?? {}))
  if (process.env[key] !== value) die()
trace({ event: 'spawned', pid: process.pid })
if (script.eager)
  trace({ event: 'authorized-eager-source', source: script.eager })
let controlOffset = 0
const dispatchControl = () => {
  const value = readFileSync(script.control, 'utf8')
  const complete = value.lastIndexOf('\n') + 1
  const lines = value.slice(controlOffset, complete).split('\n').filter(Boolean)
  controlOffset = complete
  for (const line of lines) {
    const command = JSON.parse(line)
    if (command.action === 'pauseInput' || command.action === 'resumeInput') {
      if (command.action === 'pauseInput') process.stdin.pause()
      else process.stdin.resume()
      trace({ event: command.action })
    }
    if (command.action === 'exit') process.exit(command.code ?? 0)
    if (command.action === 'raw')
      process.stdout.write(Buffer.from(command.bytes, 'base64'))
    else if (command.action === 'frames')
      for (const frame of command.frames) send(frame)
  }
}
const watcher = watch(script.control, dispatchControl)
const steps = [...script.steps]
const interpolate = (value, frame) => {
  if (Array.isArray(value))
    return value.map((entry) => interpolate(entry, frame))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        interpolate(entry, frame),
      ]),
    )
  if (typeof value === 'string' && value.startsWith('$request.'))
    return value
      .slice(9)
      .split('.')
      .reduce((result, key) => result[key], frame)
  return value
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  const frame = JSON.parse(line)
  if ('jsonrpc' in frame) die()
  // Top-level captured fields are independent from the production builders.
  // Each scenario supplies explicit nested expected bodies where required.
  const schema = captured[requestSchemas[frame.method]]
  if (
    schema &&
    ((schema.required ?? []).some(
      (key) => !Object.hasOwn(frame.params ?? {}, key),
    ) ||
      Object.keys(frame.params ?? {}).some(
        (key) => !Object.hasOwn(schema.properties, key),
      ))
  )
    die()
  trace(frame)
  if (!frame.method) return
  const step = steps.shift()
  if (
    !step ||
    step.method !== frame.method ||
    (step.expected && !isDeepStrictEqual(frame.params, step.expected))
  )
    die()
  for (const event of step.before ?? []) send(interpolate(event, frame))
  const reply = () => {
    if (step.error) send({ id: frame.id, error: step.error })
    else if (Object.hasOwn(step, 'result'))
      send({ id: frame.id, result: interpolate(step.result, frame) })
    for (const event of step.after ?? []) send(interpolate(event, frame))
    if (step.exit) process.exit(0)
  }
  if (step.delay) setTimeout(reply, step.delay)
  else reply()
})
lines.on('close', () => {
  watcher.close()
  process.exit(0)
})
process.on('SIGTERM', () => {
  watcher.close()
  lines.close()
  process.exit(0)
})
writeFileSync(script.ready, 'ready')

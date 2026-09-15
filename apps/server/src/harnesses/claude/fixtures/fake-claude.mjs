#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  readFileSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'

const directory = process.env.FORGE_CLAUDE_FIXTURE
const spec = JSON.parse(readFileSync(join(directory, 'scenario.json'), 'utf8'))
const argv = process.argv.slice(2)
const terminator = argv.indexOf('--')
const options = terminator < 0 ? argv : argv.slice(0, terminator)
const expected = [
  '--print',
  '--verbose',
  '--include-partial-messages',
  '--forward-subagent-text',
  '--allow-dangerously-skip-permissions',
]
for (const flag of expected)
  assert.equal(options.filter((arg) => arg === flag).length, 1)
for (const [flag, value] of Object.entries({
  '--input-format': 'stream-json',
  '--output-format': 'stream-json',
  '--permission-prompt-tool': 'stdio',
  '--permission-mode': 'manual',
}))
  assert.equal(options[options.indexOf(flag) + 1], value)
assert.equal(argv.includes('--dangerously-skip-permissions'), false)
assert.equal(argv.includes('--continue'), false)
assert.equal(argv.includes('--fork-session'), false)
const resume = options.find((arg) => arg.startsWith('--resume='))?.slice(9)
const session = spec.discovery
  ? undefined
  : (resume ?? options[options.indexOf('--session-id') + 1])
if (spec.discovery) {
  assert.equal(options.includes('--no-session-persistence'), true)
  assert.equal(options.includes('--session-id'), false)
  assert.equal(resume, undefined)
} else {
  assert.match(session, /^[a-zA-Z0-9-]+$/)
  assert.equal(options.includes('--session-id'), !resume)
}
if (spec.resume) assert.equal(resume, spec.resume)
if (spec.cwd) assert.equal(process.cwd(), spec.cwd)
for (const arg of spec.args ?? []) assert(argv.includes(arg))
for (const [key, value] of Object.entries(spec.env ?? {}))
  assert.equal(process.env[key], value)
for (const key of spec.absentEnv ?? [])
  assert.equal(process.env[key], undefined)
const captures = { session }
writeFileSync(
  join(directory, 'launch.json'),
  JSON.stringify({
    pid: process.pid,
    session,
    resume,
    cwd: process.cwd(),
    argv,
  }),
)
const queue = []
let waiting
createInterface({ input: process.stdin }).on('line', (line) => {
  const value = JSON.parse(line)
  appendFileSync(join(directory, 'stdin.jsonl'), `${JSON.stringify(value)}\n`)
  if (waiting) {
    const resolve = waiting
    waiting = undefined
    resolve(value)
  } else queue.push(value)
})
const next = () =>
  queue.length
    ? Promise.resolve(queue.shift())
    : new Promise((resolve) => {
        waiting = resolve
      })
function expand(value) {
  if (typeof value === 'string' && value.startsWith('$')) {
    if (value === '$new') return randomUUID()
    return value
      .slice(1)
      .split('.')
      .reduce((result, key) => result?.[key], captures)
  }
  if (Array.isArray(value)) return value.map(expand)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [key, expand(value)]),
    )
  return value
}
function subset(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (value && typeof value === 'object' && !Array.isArray(value))
      subset(actual?.[key], value)
    else assert.deepEqual(actual?.[key], value, `Unexpected ${key}`)
  }
}
function send(frame) {
  process.stdout.write(`${JSON.stringify(expand(frame))}\n`)
}
async function waitFile(name) {
  const path = join(directory, name)
  if (existsSync(path)) return
  await new Promise((resolve) => {
    const watcher = watch(dirname(path), () => {
      if (existsSync(path)) {
        watcher.close()
        resolve()
      }
    })
    if (existsSync(path)) {
      watcher.close()
      resolve()
    }
  })
}
async function actions(list) {
  for (const action of list) {
    if (action.expect) {
      const frame = await next()
      subset(frame, expand(action.expect))
      if (action.capture) captures[action.capture] = frame
      if (action.controlSuccess)
        send({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: frame.request_id,
            ...(action.response === undefined
              ? {}
              : { response: action.response }),
          },
        })
    }
    if (action.send) send(action.send)
    if (action.repeat)
      for (let index = 0; index < action.repeat; index++) {
        captures.index = index
        await actions(action.actions)
      }
    if (action.mark) writeFileSync(join(directory, action.mark), 'ready')
    if (action.wait) await waitFile(action.wait)
    if (action.descendant) {
      const child = spawn(
        process.execPath,
        ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        { stdio: 'ignore' },
      )
      writeFileSync(
        join(directory, 'descendant.json'),
        JSON.stringify({ pid: child.pid }),
      )
    }
    if (action.ignoreTerm) process.on('SIGTERM', () => {})
    if (action.exit !== undefined) process.exit(action.exit)
  }
}
try {
  if (spec.startupExit) process.exit(1)
  if (!spec.manualInitialize) {
    const init = await next()
    subset(init, {
      type: 'control_request',
      request: { subtype: 'initialize' },
    })
    captures.initialize = init
    const catalog = JSON.parse(
      readFileSync(
        new URL('./initialize-2.1.258.json', import.meta.url),
        'utf8',
      ),
    )
    if (spec.catalogModel) catalog.models[0].displayName = spec.catalogModel
    if (spec.invalidCatalog) delete catalog.models
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: init.request_id,
        response: catalog,
      },
    })
    if (!spec.invalidCatalog && !spec.discovery) {
      const thinking = await next()
      subset(thinking, {
        type: 'control_request',
        request: {
          subtype: 'set_max_thinking_tokens',
          max_thinking_tokens: null,
          thinking_display: 'summarized',
        },
      })
      send({
        type: 'control_response',
        response: { subtype: 'success', request_id: thinking.request_id },
      })
    }
  }
  writeFileSync(join(directory, 'initialized'), 'ready')
  await actions(spec.actions ?? [])
  writeFileSync(join(directory, 'finished'), 'ready')
} catch (error) {
  writeFileSync(join(directory, 'failure.txt'), error.stack)
  process.stderr.write('Claude fixture assertion failed\n')
  process.exit(2)
}

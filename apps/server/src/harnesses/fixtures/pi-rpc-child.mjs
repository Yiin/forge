#!/usr/bin/env node
// Synthetic Pi 0.84.0 peer. This file never imports Pi or contacts a provider.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const arg = (key) => args[args.indexOf(key) + 1]
const directory = arg('--fixture-dir')
const config = JSON.parse(readFileSync(join(directory, 'fixture.json'), 'utf8'))
const root = args.includes('--no-session')
  ? join(directory, 'ephemeral')
  : arg('--session-dir')
mkdirSync(root, { recursive: true })
let sessionFile = args.includes('--session')
  ? arg('--session')
  : join(root, 'native-session.jsonl')
let sessionId = 'native-session'
const header = () => ({
  type: 'session',
  version: 3,
  id: sessionId,
  timestamp: new Date(0).toISOString(),
  cwd: process.cwd(),
})
if (config.resumeRace === 'remove') unlinkSync(sessionFile)
if (config.resumeRace === 'empty') writeFileSync(sessionFile, '')
if (config.resumeRace === 'replace') {
  writeFileSync(`${sessionFile}.replacement`, readFileSync(sessionFile))
  renameSync(`${sessionFile}.replacement`, sessionFile)
}
if (config.resumeRace === 'append') appendFileSync(sessionFile, '\n')
if (existsSync(sessionFile) && readFileSync(sessionFile).length) {
  sessionId = JSON.parse(readFileSync(sessionFile, 'utf8').split('\n')[0]).id
} else if (args.includes('--session')) {
  sessionId = 'native-rewritten'
  writeFileSync(sessionFile, `${JSON.stringify(header())}\n`)
}
if (config.changeIdentity) {
  sessionId = 'changed-native'
  sessionFile = join(root, 'changed.jsonl')
}
const model = {
  id: 'model/one',
  provider: 'fake',
  name: 'Fake model',
  reasoning: true,
  input: ['text', 'image'],
  contextWindow: 8192,
  maxTokens: 1024,
}
const state = {
  model,
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'one-at-a-time',
  followUpMode: 'all',
  sessionFile,
  sessionId,
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
}
if (config.noModel) delete state.model
const usage = {
  input: 1,
  output: 2,
  totalTokens: 3,
  cacheRead: 0,
  cacheWrite: 0,
}
const assistant = (
  content = [{ type: 'text', text: 'done' }],
  stopReason = 'stop',
) => ({
  role: 'assistant',
  content,
  api: 'fake-api',
  provider: 'fake',
  model: 'model/one',
  timestamp: 1,
  usage,
  stopReason,
})
let entry = 0
const nativeResolvers = new Set()
function persist(message) {
  if (!existsSync(sessionFile))
    writeFileSync(sessionFile, `${JSON.stringify(header())}\n`)
  const nativeEntry = {
    type: 'message',
    id: `entry-${++entry}`,
    parentId: entry === 1 ? null : `entry-${entry - 1}`,
    timestamp: new Date(entry).toISOString(),
    message,
  }
  appendFileSync(sessionFile, `${JSON.stringify(nativeEntry)}\n`)
  state.messageCount++
}
function output(values) {
  for (const value of values)
    if (
      value.type === 'extension_ui_request' &&
      ['select', 'confirm', 'input', 'editor'].includes(value.method)
    )
      nativeResolvers.add(value.id)
  for (const value of values)
    if (value.type === 'message_end') persist(value.message)
  const raw =
    values
      .map((value) => JSON.stringify(value))
      .join(config.crlf ? '\r\n' : '\n') + '\n'
  if (config.splitAt) {
    process.stdout.write(raw.slice(0, config.splitAt))
    process.stdout.write(raw.slice(config.splitAt))
  } else process.stdout.write(raw)
}
const respond = (command, data, success = true) =>
  output([
    {
      type: 'response',
      id: command.id,
      command: command.type,
      success,
      ...(success
        ? data === undefined
          ? {}
          : { data }
        : { error: data ?? 'Synthetic rejection' }),
    },
  ])
const held = new Map()
const processed = new Set()
function controls() {
  for (const name of readdirSync(join(directory, 'control')).sort()) {
    if (!name.endsWith('.json') || processed.has(name)) continue
    processed.add(name)
    const control = JSON.parse(
      readFileSync(join(directory, 'control', name), 'utf8'),
    )
    if (control.resumeInput) process.stdin.resume()
    if (control.state) Object.assign(state, control.state)
    if (control.silentExpire) nativeResolvers.delete(control.silentExpire)
    if (control.release)
      for (const command of held.values())
        if (control.release === command.type) {
          respond(command)
          held.delete(command.id)
        }
    if (control.events) output(control.events)
    if (control.raw) process.stdout.write(Buffer.from(control.raw, 'base64'))
    if (control.response) output([control.response])
    if (!control.skipAcknowledgement)
      writeFileSync(join(directory, `processed-${name}`), '')
    if (control.exit !== undefined) process.exit(control.exit)
  }
}
mkdirSync(join(directory, 'control'), { recursive: true })
const watcher = watch(join(directory, 'control'), controls)
writeFileSync(
  join(directory, 'started.json'),
  JSON.stringify({
    pid: process.pid,
    args,
    env: Object.fromEntries(
      (config.envKeys ?? []).map((key) => [key, process.env[key] ?? null]),
    ),
  }),
)
if (config.descendant) {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)"],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
  writeFileSync(join(directory, 'descendant'), String(child.pid))
}
if (config.ignoreTerm) process.on('SIGTERM', () => {})
if (config.startupDialog) {
  // Pi awaits session_start before installing its stdin reader. No early reader here.
  output([
    {
      type: 'extension_ui_request',
      id: 'startup-native',
      method: 'confirm',
      title: 'Startup',
      message: 'Continue?',
    },
  ])
  await new Promise(() => {})
}
if (config.startupEffect)
  writeFileSync(join(directory, 'unforwarded-startup-effect'), 'hook ran')
if (config.startupRaw)
  process.stdout.write(Buffer.from(config.startupRaw, 'base64'))
if (config.startupExit !== undefined) process.exit(config.startupExit)
if (config.startupHang) await new Promise(() => {})
const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  const command = JSON.parse(line)
  appendFileSync(join(directory, 'wire.jsonl'), `${JSON.stringify(command)}\n`)
  if (command.type === 'extension_ui_response') {
    writeFileSync(
      join(directory, 'last-native-reply.json'),
      JSON.stringify({
        id: command.id,
        handled: nativeResolvers.delete(command.id),
      }),
    )
    return
  }
  if ((config.hold ?? []).includes(command.type)) {
    held.set(command.id, command)
    return
  }
  if ((config.reject ?? []).includes(command.type)) {
    respond(command, 'Synthetic rejection', false)
    return
  }
  switch (command.type) {
    case 'get_state':
      respond(command, { ...state })
      break
    case 'get_available_models':
      respond(command, {
        models: config.emptyModels
          ? []
          : [model, { ...model, id: 'model/two' }],
      })
      break
    case 'get_available_thinking_levels':
      respond(command, { levels: ['off', 'low', 'high'] })
      break
    case 'get_commands':
      respond(command, {
        commands: [
          {
            name: 'handled',
            source: 'extension',
            description: 'Fake command',
            sourceInfo: { source: 'fixture' },
          },
        ],
      })
      break
    case 'set_model':
      state.model = {
        ...model,
        provider: command.provider,
        id: command.modelId,
      }
      respond(command, state.model)
      break
    case 'set_thinking_level':
      state.thinkingLevel = config.clamp ? 'off' : command.level
      respond(command)
      break
    case 'set_steering_mode':
      state.steeringMode = command.mode
      respond(command)
      break
    case 'set_follow_up_mode':
      state.followUpMode = command.mode
      respond(command)
      break
    case 'abort':
      state.isStreaming = false
      respond(command)
      break
    case 'steer':
    case 'follow_up':
      respond(command)
      break
    case 'prompt': {
      if (config.behavior === 'preflight') {
        respond(command, 'Synthetic preflight failure', false)
        break
      }
      if (
        config.behavior === 'handled' ||
        config.behavior === 'extension-error'
      ) {
        if (config.behavior === 'extension-error')
          output([
            {
              type: 'extension_error',
              extensionPath: 'fixture',
              event: 'input',
              error: 'Synthetic extension failure',
            },
          ])
        respond(command)
        break
      }
      state.isStreaming = true
      if (!config.lateAck) respond(command)
      else held.set(command.id, command)
      if (config.behavior === 'manual') {
        if (config.pauseInput) {
          process.stdin.pause()
          writeFileSync(join(directory, 'stdin-paused'), '')
        }
        break
      }
      output([
        { type: 'agent_start' },
        { type: 'turn_start' },
        {
          type: 'message_start',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: command.message },
              ...(command.images ?? []),
            ],
            timestamp: 0,
          },
        },
        {
          type: 'message_end',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: command.message },
              ...(command.images ?? []),
            ],
            timestamp: 0,
          },
        },
        { type: 'message_start', message: assistant([], 'pending') },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
        },
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'done longer',
          },
        },
        { type: 'message_end', message: assistant() },
        { type: 'agent_end', messages: [assistant()], willRetry: false },
      ])
      state.isStreaming = false
      output([{ type: 'agent_settled' }])
      break
    }
    default:
      respond(command, 'Unknown synthetic command', false)
  }
})
reader.on('close', () => watcher.close())

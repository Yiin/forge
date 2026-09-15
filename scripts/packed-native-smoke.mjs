#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const releaseArgument = process.argv[2]
if (!releaseArgument)
  throw new Error('Usage: packed-native-smoke.mjs <release-directory>')
const release = resolve(releaseArgument)
const scriptRoot = resolve(new URL('../', import.meta.url).pathname)
const releaseReal = await realpath(release)
if (releaseReal === scriptRoot || releaseReal.startsWith(`${scriptRoot}/`))
  throw new Error('Release directory must be outside the checkout')
if (!(await stat(join(releaseReal, 'apps/server/src/index.js'))).isFile())
  throw new Error('Release directory has no packed server entrypoint')
const fixture = resolve(
  new URL(
    '../apps/server/src/harnesses/claude/fixtures/fake-claude.mjs',
    import.meta.url,
  ).pathname,
)
const work = await mkdtemp(join(tmpdir(), 'forge-packed-native-'))
const serverData = join(work, 'data')
const fixtureData = join(work, 'fixture')
let child
try {
  await mkdir(fixtureData, { recursive: true })
  await writeFile(
    join(fixtureData, 'scenario.json'),
    JSON.stringify({
      cwd: serverData,
      actions: [
        {
          expect: { type: 'user', message: { role: 'user' } },
          capture: 'prompt',
        },
        {
          send: {
            type: 'assistant',
            message: {
              id: '$new',
              content: [{ type: 'text', text: 'packed-native-ok' }],
            },
            uuid: '$new',
          },
        },
        { wait: 'release' },
        {
          send: {
            type: 'result',
            subtype: 'success',
            session_id: '$session',
            user_message_uuid: '$prompt.uuid',
            usage: { input_tokens: 1, output_tokens: 1 },
            uuid: '$new',
          },
        },
      ],
    }),
  )
  const config = join(work, 'forge.toml')
  await writeFile(
    config,
    [
      `dataDir = ${JSON.stringify(serverData)}`,
      'port = 0',
      '[harness.claude]',
      'name = "Packed Claude fixture"',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(fixture)}]`,
      `env = { FORGE_CLAUDE_FIXTURE = ${JSON.stringify(fixtureData)} }`,
      'protocol = "acp"',
      'adapterKind = "native"',
      'enabled = true',
      '',
    ].join('\n'),
  )
  child = spawn(
    process.execPath,
    [join(releaseReal, 'apps/server/src/index.js')],
    {
      cwd: releaseReal,
      env: {
        ...process.env,
        HOME: join(work, 'home'),
        XDG_CONFIG_HOME: join(work, 'home', '.config'),
        FORGE_CONFIG: config,
        FORGE_DATA_DIR: serverData,
        FORGE_WEB_DIR: join(release, 'web'),
        FORGE_PORT: '0',
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const output = []
  let outputBytes = 0
  let childError
  child.on('error', (error) => {
    childError = error
  })
  const capture = (chunk) => {
    outputBytes += chunk.length
    if (outputBytes <= 65536) output.push(chunk.toString())
    else if (child.exitCode === null) child.kill('SIGKILL')
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  const waitFor = async (pattern) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const text = output.join('')
      const match = text.match(pattern)
      if (match) return match
      if (childError) throw childError
      if (child.exitCode !== null)
        throw new Error(`Packed server exited: ${text}`)
      await new Promise((done) => setTimeout(done, 25))
    }
    throw new Error(`Timed out waiting for ${pattern}: ${output.join('')}`)
  }
  const request = async (path, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(5000),
    })
    const body = await response.json()
    assert.equal(response.ok, true, JSON.stringify(body))
    return body
  }
  let port
  port = Number((await waitFor(/FORGE_LISTENING (\d+)/))[1])
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Packed native smoke', path: serverData }),
  })
  const account = await request('/api/harness-accounts', {
    method: 'POST',
    body: JSON.stringify({
      harnessKey: 'claude',
      label: 'Packed Claude fixture',
      kind: 'claude',
      adapterKind: 'native',
    }),
  })
  const session = await request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      harness: 'claude',
      accountId: account.id,
      cwd: serverData,
    }),
  })
  await request(`/api/sessions/${session.id}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ text: 'verify packed native runtime' }),
  })
  await writeFile(join(fixtureData, 'release'), 'ready')
  const deadline = Date.now() + 15000
  let snapshot
  while (Date.now() < deadline) {
    snapshot = await request(`/api/sessions/${session.id}/messages`)
    if (snapshot.messages.some((message) => message.type === 'turn_end')) break
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.ok(
    snapshot?.messages.some((message) => message.type === 'turn_end'),
    JSON.stringify({ output, messages: snapshot?.messages }),
  )
  assert.ok(
    snapshot.messages.some(
      (message) =>
        message.type === 'text_delta' &&
        message.content?.text === 'packed-native-ok',
    ),
  )
  console.log(
    JSON.stringify({ passed: true, release, port, sessionId: session.id }),
  )
} finally {
  if (child) {
    if (child.exitCode === null) child.kill('SIGTERM')
    if (child.exitCode === null) {
      await Promise.race([
        new Promise((done) => child.once('close', done)),
        new Promise((done) => setTimeout(done, 5000)),
      ])
      if (child.exitCode === null) {
        child.kill('SIGKILL')
        await Promise.race([
          new Promise((done) => child.once('close', done)),
          new Promise((done) => setTimeout(done, 1000)),
        ])
      }
    }
    const launch = await readFile(join(fixtureData, 'launch.json'), 'utf8')
      .then((value) => JSON.parse(value))
      .catch(() => null)
    if (Number.isSafeInteger(launch?.pid) && launch.pid > 1) {
      try {
        process.kill(-launch.pid, 'SIGTERM')
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : undefined
        if (!['ESRCH', 'EPERM'].includes(code))
          console.error(`Native fixture cleanup failed: ${String(error)}`)
      }
    }
  }
  await rm(work, { recursive: true, force: true })
}

#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createRequire } from 'node:module'
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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function closePackedServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

export async function packedNativeSmoke(releaseArgument) {
  if (!releaseArgument)
    throw new Error('Usage: packed-native-smoke.mjs <release-directory>')
  const scriptRoot = fileURLToPath(new URL('../', import.meta.url))
  const release = await realpath(resolve(releaseArgument))
  if (release === resolve(scriptRoot) || release.startsWith(scriptRoot))
    throw new Error('Release directory must be outside the checkout')
  const entry = join(release, 'apps/server/src/index.js')
  assert.ok((await stat(entry)).isFile())
  const fixture = fileURLToPath(
    new URL(
      '../apps/server/src/harnesses/claude/fixtures/fake-claude.mjs',
      import.meta.url,
    ),
  )
  const work = await mkdtemp(join(tmpdir(), 'forge-packed-native-'))
  const serverData = join(work, 'data'),
    fixtureData = join(work, 'fixture')
  let server, failure, receipt
  try {
    const home = join(work, 'home')
    await mkdir(fixtureData)
    await mkdir(home)
    // Only this standalone driver changes its environment. The packed server uses its real startup path.
    for (const name of Object.keys(process.env)) delete process.env[name]
    Object.assign(process.env, {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      XDG_RUNTIME_DIR: join(home, '.local/run'),
      FORGE_CONFIG: join(work, 'forge.toml'),
      FORGE_DATA_DIR: serverData,
      FORGE_ACCOUNTS_DIR: join(home, 'accounts'),
      FORGE_WEB_DIR: join(release, 'web'),
      FORGE_PORT: '0',
      NODE_ENV: 'test',
      LANG: 'C.UTF-8',
    })
    process.chdir(release)
    const require = createRequire(pathToFileURL(entry))
    const nativePath = join(dirname(entry), 'build/Release/pty.node')
    const native = require(nativePath)
    assert.equal(native.forgeOwnedApiVersion, 1)
    assert.equal(typeof native.spawnOwnedV1, 'function')
    const build = JSON.parse(
      await readFile(
        join(dirname(nativePath), 'forge-owned-build.json'),
        'utf8',
      ),
    )
    assert.equal(
      createHash('sha256')
        .update(await readFile(nativePath))
        .digest('hex'),
      build.output.sha256,
    )
    const sidecar = join(dirname(entry), 'cursor-sidecar')
    const sidecarRequire = createRequire(
      pathToFileURL(join(sidecar, 'sidecar.mjs')),
    )
    const sdkPath = await realpath(sidecarRequire.resolve('@cursor/sdk'))
    assert.ok(sdkPath.startsWith(sidecar + '/'))
    const sdk = sidecarRequire(sdkPath)
    assert.equal(typeof sdk.JsonlLocalAgentStore, 'function')
    const runtime = await import(
      pathToFileURL(join(sidecar, 'sidecar-runtime.mjs')).href
    )
    assert.equal(typeof runtime.CursorSidecarRuntime, 'function')
    const sidecarManifest = JSON.parse(
      await readFile(join(sidecar, 'manifest.json'), 'utf8'),
    )
    assert.equal(sidecarManifest.sdkVersion, '1.0.28')
    await writeFile(
      process.env.FORGE_CONFIG,
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
    const scenario = async (text, resume) =>
      writeFile(
        join(fixtureData, 'scenario.json'),
        JSON.stringify({
          cwd: serverData,
          ...(resume ? { resume } : {}),
          actions: [
            {
              expect: { type: 'user', message: { role: 'user' } },
              capture: 'prompt',
            },
            {
              send: {
                type: 'assistant',
                message: { id: '$new', content: [{ type: 'text', text }] },
                uuid: '$new',
              },
            },
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
    await scenario('packed-native-ok')
    const { startServer } = await import(pathToFileURL(entry).href)
    const start = async () => {
      server = startServer(0)
      if (!server.listening) await once(server, 'listening')
      return `http://127.0.0.1:${server.address().port}`
    }
    let base = await start()
    const request = async (path, init = {}) => {
      const response = await fetch(base + path, {
        ...init,
        headers: { 'content-type': 'application/json', ...init.headers },
        signal: AbortSignal.timeout(5000),
      })
      const body = await response.json()
      assert.equal(response.ok, true, JSON.stringify(body))
      return body
    }
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
    const prompt = async (text, expected, completed) => {
      await request(`/api/sessions/${session.id}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
      const deadline = Date.now() + 15000
      let snapshot
      while (Date.now() < deadline) {
        snapshot = await request(`/api/sessions/${session.id}/messages`)
        if (
          snapshot.messages.filter((row) => row.type === 'turn_end').length ===
          completed
        )
          break
        await new Promise((done) => setTimeout(done, 50))
      }
      assert.equal(
        snapshot?.messages.filter((row) => row.type === 'turn_end').length,
        completed,
      )
      assert.ok(
        snapshot.messages.some(
          (row) =>
            ['text_delta', 'content_snapshot'].includes(row.type) &&
            row.content?.text === expected,
        ),
      )
      assert.equal(
        snapshot.messages.some((row) => row.type === 'error'),
        false,
      )
    }
    await prompt('verify packed native runtime', 'packed-native-ok', 1)
    const first = JSON.parse(
      await readFile(join(fixtureData, 'launch.json'), 'utf8'),
    )
    assert.equal(first.resume, undefined)
    const before = await request(`/api/sessions/${session.id}`)
    assert.equal(before.providerSessionId, first.session)
    await closePackedServer(server)
    server = undefined
    await scenario('packed-native-resumed', first.session)
    base = await start()
    const restored = await request(`/api/sessions/${session.id}`)
    assert.equal(restored.providerSessionId, first.session)
    assert.equal(restored.accountId, account.id)
    assert.equal(restored.cwd, serverData)
    await prompt('verify original packed resume', 'packed-native-resumed', 2)
    const resumed = JSON.parse(
      await readFile(join(fixtureData, 'launch.json'), 'utf8'),
    )
    assert.equal(resumed.resume, first.session)
    assert.equal(resumed.session, first.session)
    assert.ok(resumed.argv.includes(`--resume=${first.session}`))
    const wire = (await readFile(join(fixtureData, 'stdin.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      wire
        .filter((frame) => frame.type === 'user')
        .map((frame) => frame.message.content),
      [
        [{ type: 'text', text: 'verify packed native runtime' }],
        [{ type: 'text', text: 'verify original packed resume' }],
      ],
    )
    receipt = {
      passed: true,
      release,
      sessionId: session.id,
      providerSessionId: first.session,
      resumed: true,
      terminalApi: native.forgeOwnedApiVersion,
      cursorSdk: sidecarManifest.sdkVersion,
    }
  } catch (error) {
    failure = error
  }
  if (server) {
    try {
      await closePackedServer(server)
    } catch (error) {
      failure = failure
        ? new AggregateError(
            [failure, error],
            'Packed smoke and cleanup failed',
          )
        : error
    }
  }
  if (failure) {
    console.error(`Packed smoke evidence retained: ${work}`)
    throw failure
  }
  await rm(work, { recursive: true, force: true })
  console.log(JSON.stringify(receipt))
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await packedNativeSmoke(process.argv[2])

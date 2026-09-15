import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  stat,
  realpath,
} from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type * as SDK from '@cursor/sdk'
import { CursorStore } from './store.js'
import { CursorResources, cursorLimits } from './limits.js'

export async function storeContract(sdk: typeof SDK, root: string) {
  const directory = join(root, 'sdk-contract'),
    workspace = join(root, 'workspace')
  await mkdir(directory, { mode: 0o700 })
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  const store = new CursorStore(
    directory,
    workspace,
    new sdk.JsonlLocalAgentStore(directory),
    new CursorResources(),
    cursorLimits(),
    true,
  )
  store.beginAttempt('first')
  const platform = await sdk.createAgentPlatform({
    localStore: store,
    workspaceRef: workspace,
    scopedWorkspaceRef: workspace,
    eventNotifier: sdk.createInMemoryRunEventNotifier(),
  })
  const created = await platform.store.createAgent({
      agentId: 'actual-store-contract',
      workspaceRef: workspace,
      metadata: { fixture: 'unchanged' },
    }),
    agentId = created.agent.agentId,
    runId = created.run.runId
  await platform.store.markRunStarting(agentId, runId)
  const bytes = Buffer.from('checkpoint contract'),
    blobId = createHash('sha256').update(bytes).digest('hex')
  await store.checkpoints.create({ agentId, blobId, data: bytes })
  await store.checkpoints.update({ agentId, blobId, data: bytes })
  if (
    !Buffer.from((await store.checkpoints.get({ agentId, blobId }))!).equals(
      bytes,
    ) ||
    (await store.checkpoints.list()).items[0] !== blobId
  )
    throw new Error('Actual checkpoint surface mismatch')
  await platform.store.patchCheckpoint(agentId, runId, {
    blobId,
    storeKind: 'local-agent-store',
  })
  await platform.eventStore!.appendRunEvent({
    runId,
    eventType: 'contract',
    payload: { text: 'source event' },
    idempotencyKey: 'event-one',
  })
  await platform.eventStore!.appendRunEvent({
    runId,
    eventType: 'contract',
    payload: { text: 'duplicate' },
    idempotencyKey: 'event-one',
  })
  if ((await store.runEvents.list({ runId })).items.length !== 1)
    throw new Error('Actual event idempotency mismatch')
  await platform.store.cancelRun(agentId, runId)
  await platform.store.markRunTerminal(agentId, runId, {
    status: 'FINISHED',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
    },
  })
  await store.drain(true)
  store.endAttempt()
  store.beginAttempt('follow-up')
  const followUp = await platform.store.createFollowUpRun(agentId, {})
  await platform.store.cancelRun(agentId, followUp.runId)
  await store.drain(true)
  const stale = (await store.runs.get({ agentId, runId: followUp.runId }))!
  const current = (await store.runs.get({ agentId, runId: followUp.runId }))!
  await store.runs.update({ run: { ...current } })
  let rejected = false
  try {
    await store.runs.update({ run: { ...stale, status: 'running' } })
  } catch {
    rejected = true
  }
  if (!rejected || !store.error)
    throw new Error('Actual stale revision was accepted')
  let latched = false
  try {
    await store.runs.delete({ filter: { agentIds: [agentId] } })
  } catch {
    latched = true
  }
  if (!latched) throw new Error('Actual rollback bypassed the error latch')
  const fresh = new CursorStore(
    directory,
    workspace,
    new sdk.JsonlLocalAgentStore(directory),
    new CursorResources(),
    cursorLimits(),
    false,
  )
  await fresh.runs.delete({ filter: { runIds: [runId] } })
  if ((await fresh.runEvents.list({ runId })).items.length !== 0)
    throw new Error('Actual runs.delete missed its internal event cascade')
  await fresh.runEvents.delete({ filter: { runIds: [runId] } })
  const inspected = await fresh.drain(true)
  if (
    JSON.stringify(inspected.rows.agents[0].sdkMetadata) !==
    JSON.stringify({ fixture: 'unchanged' })
  )
    throw new Error('SDK metadata changed')
  const deletion = await sdk.createAgentPlatform({
    localStore: fresh,
    workspaceRef: workspace,
    scopedWorkspaceRef: workspace,
    eventNotifier: sdk.createInMemoryRunEventNotifier(),
  })
  await deletion.store.deleteAgent(agentId)
  const deleted = await fresh.drain(true)
  if (Object.values(deleted.rows).some((rows) => rows.length))
    throw new Error('Actual deleteAgent left owned rows')
  return {
    passed: true,
    scope: 'store-contract',
    initialUntagged: true,
    checkpointSurfaces: true,
    eventSurfaces: true,
    followUp: true,
    terminalUsage: true,
    staleRevisionRejected: true,
    latchPreserved: true,
    deleteCascade: true,
    metadataUnchanged: true,
    deleteAgentCascade: true,
  }
}

export async function probe(sdk: typeof SDK, root: string, artifact: string) {
  const checks: Record<string, unknown> = {
    defaultEsm: true,
    parserExport: typeof (sdk as unknown as Record<string, unknown>)
      .parseStoredSdkCredentials,
  }
  const failures: string[] = []
  const check = async (name: string, operation: () => Promise<unknown>) => {
    try {
      checks[name] = (await operation()) ?? true
    } catch (error) {
      checks[name] = {
        failed: true,
        message:
          error instanceof Error ? error.message.slice(0, 4096) : 'failed',
      }
      failures.push(name)
    }
  }
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  await writeFile(join(workspace, 'fixture.sh'), 'echo cursor_fixture\n')
  const platformPath = join(artifact, 'node_modules/@cursor/sdk-linux-x64')
  const require = createRequire(join(artifact, 'sidecar.mjs'))
  await check('parser', async () => {
    const Parser = require(join(platformPath, 'vendor/tree-sitter'))
    const Bash = require(join(platformPath, 'vendor/tree-sitter-bash'))
    const parser = new Parser()
    parser.setLanguage(Bash)
    const tree = parser.parse('echo cursor_fixture\n')
    const text = tree.rootNode.toString()
    tree.delete?.()
    parser.delete?.()
    if (!text.includes('command'))
      throw new Error('parser result missing command')
    return true
  })
  await check('search', async () => {
    const { stdout } = await promisify(execFile)(
      join(platformPath, 'bin/rg'),
      ['--no-config', 'cursor_fixture', workspace],
      { timeout: 5000, maxBuffer: 4096 },
    )
    if (!stdout.includes('cursor_fixture'))
      throw new Error('search result missing fixture')
    return true
  })
  const storePath = join(root, 'sdk')
  await mkdir(storePath, { recursive: true, mode: 0o700 })
  const store = new sdk.JsonlLocalAgentStore(storePath)
  const platform = await sdk.createAgentPlatform({
    localStore: store,
    workspaceRef: workspace,
    scopedWorkspaceRef: workspace,
    eventNotifier: sdk.createInMemoryRunEventNotifier(),
  })
  const options: SDK.AgentOptions = {
    apiKey: '',
    model: { id: 'cursor-synthetic-probe' },
    local: {
      cwd: workspace,
      store,
      settingSources: [],
      autoReview: true,
      sandboxOptions: { enabled: true },
      enableAgentRetries: false,
    },
    disallowedTools: ['askQuestion', 'generateImage'],
  }
  await check('sandbox', async () => {
    const release = await platform.prewarmLocalWorkspace(options)
    await release()
    return true
  })
  await check('sandboxPreflightEvidence', async () => {
    const trueFile = await lstat('/bin/true')
    if (!trueFile.isFile() && !trueFile.isSymbolicLink())
      throw new Error('The fixture has no /bin/true file')
    const policyDirectory = join(root, 'home/.cursor/sandbox-policies')
    const policies = (await readdir(policyDirectory)).filter((name) =>
      /^sandbox-policy-[a-f0-9]{16}$/.test(name),
    )
    if (policies.length > 8)
      throw new Error(
        `SDK-generated preflight policy count: ${policies.length}`,
      )
    // Diagnostic translation of the pinned rf1/if1/nf1 preflight policy. No private SDK call.
    const generatedByDiagnostic = policies.length === 0
    const policy = join(
      policyDirectory,
      policies.sort()[0] ?? `sandbox-policy-${randomBytes(8).toString('hex')}`,
    )
    if (generatedByDiagnostic) {
      const globals = [
        '/bin',
        '/sbin',
        '/usr/bin',
        '/usr/sbin',
        '/usr/local/bin',
        '/lib',
        '/lib64',
        '/usr/lib',
        '/usr/lib64',
        '/usr/local/lib',
        '/usr/libexec',
        '/usr/share',
        '/etc/ld.so.cache',
        '/etc/ld.so.conf',
        '/etc/ld.so.conf.d',
        '/etc/ssl/certs',
        '/etc/ssl/openssl.cnf',
        '/etc/ssl/cert.pem',
        '/etc/ssl/ca-bundle.pem',
        '/etc/ssl/certs/ca-certificates.crt',
        '/etc/pki/tls/certs',
        '/etc/pki/tls/openssl.cnf',
        '/etc/pki/ca-trust/extracted',
        '/etc/resolv.conf',
        '/etc/hosts',
        '/etc/nsswitch.conf',
        '/etc/gai.conf',
        '/etc/alternatives',
        '/etc/profile',
        '/etc/bash.bashrc',
        '/etc/zsh/zshenv',
        '/etc/zsh/zprofile',
        '/etc/zsh/zshrc',
        '/etc/zsh/zlogin',
        '/etc/gitconfig',
      ]
      for (const name of [
        '.bashrc',
        '.bash_profile',
        '.profile',
        '.zshenv',
        '.zprofile',
        '.zshrc',
        '.zlogin',
        '.gitconfig',
      ]) {
        const path = join(process.env.HOME!, name)
        if (
          await lstat(path).then(
            (row) => row.isFile(),
            () => false,
          )
        )
          globals.push(path)
      }
      const rg = join(platformPath, 'bin/rg')
      if ((await stat(rg)).isFile()) globals.push(rg)
      const hardcodedReadPaths = [
        ...new Set(
          await Promise.all(
            globals.map((path) => realpath(path).catch(() => path)),
          ),
        ),
      ]
      await mkdir(policyDirectory, { recursive: true, mode: 0o700 })
      const additionalReadonlyPaths: Record<string, string[]> = {
        [policyDirectory]: ['**'],
        [await realpath(policyDirectory)]: ['**'],
      }
      await writeFile(
        policy,
        JSON.stringify({
          sandbox: {
            type: 'workspace_readwrite',
            cwd: process.cwd(),
            readBoundary: 'system',
            hardcodedReadPaths,
            additionalReadonlyPaths,
            networkAccess: false,
            additionalReadwritePaths: [],
            disableTmpWrite: false,
          },
        }),
        { flag: 'wx', mode: 0o600 },
      )
    }
    const bytes = await readFile(policy)
    if (bytes.length > 65536)
      throw new Error('Generated policy exceeded the diagnostic limit')
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (
      parsed.sandbox?.type !== 'workspace_readwrite' ||
      parsed.sandbox.cwd !== process.cwd()
    )
      throw new Error('Unexpected generated preflight policy')
    const helper = join(platformPath, 'bin/cursorsandbox')
    let exitStatus: number | string = 0,
      stderr = ''
    const rg = join(platformPath, 'bin/rg')
    const env = {
      ...process.env,
      PATH: `${join(platformPath, 'bin')}:${process.env.PATH}`,
      CURSOR_RIPGREP_PATH: rg,
    }
    try {
      await promisify(execFile)(
        helper,
        ['--policy', policy, '--preflight-only', '--', '/bin/true'],
        { timeout: 15000, maxBuffer: 4096, cwd: process.cwd(), env },
      )
    } catch (error) {
      const failure = error as Error & { code: number | string; stderr: string }
      exitStatus = failure.code
      stderr = String(failure.stderr ?? '').slice(0, 4096)
    }
    return {
      helper,
      helperSha256: createHash('sha256')
        .update(await readFile(helper))
        .digest('hex'),
      trueExists: true,
      generatedByDiagnostic,
      policyCount: policies.length,
      policy: parsed,
      policySha256: createHash('sha256').update(bytes).digest('hex'),
      exitStatus,
      stderr,
    }
  })
  await check('sdkRevisionPropagation', async () => {
    const directory = join(root, 'revision-store')
    await mkdir(directory, { mode: 0o700 })
    const wrapped = new CursorStore(
      directory,
      workspace,
      new sdk.JsonlLocalAgentStore(directory),
      new CursorResources(),
      cursorLimits(),
      true,
    )
    const adapter = await sdk.createAgentPlatform({
      localStore: wrapped,
      workspaceRef: workspace,
      scopedWorkspaceRef: workspace,
      eventNotifier: sdk.createInMemoryRunEventNotifier(),
    })
    wrapped.beginAttempt('revision-probe')
    const created = await adapter.store.createAgent({
      agentId: 'cursor-revision-fixture',
      workspaceRef: workspace,
    })
    await adapter.store.markRunStarting(
      created.agent.agentId,
      created.run.runId,
    )
    const stale = await wrapped.runs.get({
      agentId: created.agent.agentId,
      runId: created.run.runId,
    })
    await adapter.store.cancelRun(created.agent.agentId, created.run.runId)
    await adapter.store.markRunTerminal(
      created.agent.agentId,
      created.run.runId,
      { status: 'FINISHED' },
    )
    await wrapped.drain(true)
    let rejected = false
    try {
      await wrapped.runs.update({ run: { ...stale!, status: 'running' } })
    } catch {
      rejected = true
    }
    if (!rejected || !wrapped.error)
      throw new Error('Stale SDK row was not rejected')
    const disk = await new sdk.JsonlLocalAgentStore(directory).runs.get({
      agentId: created.agent.agentId,
      runId: created.run.runId,
    })
    if (disk?.status !== 'cancelled') throw new Error('Terminal row changed')
    return true
  })
  let agent: SDK.SDKAgent | undefined
  await check('jsonl', async () => {
    agent = await platform.createAgent(options)
    const row = await store.agents.get({ agentId: agent.agentId })
    if (!row?.activeRunId) throw new Error('missing initial queued run')
    const bytes = Buffer.from('checkpoint fixture')
    const blobId = createHash('sha256').update(bytes).digest('hex')
    await store.checkpoints.create({
      agentId: agent.agentId,
      blobId,
      data: bytes,
    })
    const loaded = await store.checkpoints.get({
      agentId: agent.agentId,
      blobId,
    })
    if (!loaded || !Buffer.from(loaded).equals(bytes))
      throw new Error('checkpoint mismatch')
    await readFile(join(storePath, 'agents.ndjson'))
    const resumed = await platform.resumeAgent(agent.agentId, options)
    if (resumed.agentId !== agent.agentId)
      throw new Error('resume changed identity')
    await resumed[Symbol.asyncDispose]()
    return true
  })
  if (agent)
    await check('lazySend', async () => {
      const run = await agent!.send('synthetic rejection fixture')
      const stream = (async () => {
        for await (const _message of run.stream()) {
          /* Drain once. */
        }
      })()
      const result = await run.wait()
      await stream
      if (result.status !== 'error')
        throw new Error('fixture did not reject send')
      return {
        status: result.status,
        error: result.error?.message?.slice(0, 4096),
      }
    })
  if (agent) await check('dispose', () => agent![Symbol.asyncDispose]())
  return { passed: failures.length === 0, checks, failures }
}

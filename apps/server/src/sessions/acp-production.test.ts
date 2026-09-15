import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { createProductionAcpAdapter } from './acp-factory.js'
import { createNativeResources } from './native-factory.js'
import { createNativeAttachmentLoader } from '../uploads/native.js'
import { AcpResourceHost } from '../harnesses/acp/limits.js'
import { acpProviderDescriptors } from '../harnesses/acp/profiles.js'
import type {
  HarnessEvent,
  HarnessHandle,
  HarnessSession,
} from '../harnesses/types.js'
import { expectStopped } from '../harnesses/transport-test-helpers.js'
import { UploadStore } from '../uploads/store.js'
import { migrate } from '../db/migrate.js'
import { createSession, appendMessage } from '../db/queries.js'
import { acpArtifactRoutes } from '../http/acp-artifacts.js'
import { nativeChildRoutes } from '../http/native-children.js'
import { SessionManager } from './manager.js'
import { nativeHarness } from './native.js'
import { NativeInteractions } from './native-interactions.js'
import { EventBus } from '../events/bus.js'
import { QuestionManager } from '../acp/questions.js'
import { questionRoutes } from '../http/questions.js'
import { stringify } from 'smol-toml'
import { loadConfigSync, reconcileConfig, convertConfig } from '../config.js'
import { HarnessAccountStore } from '../accounts/store.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.at(-1)!()
    cleanups.pop()
  }
})
async function fixture(
  profile: 'grok' | 'gemini' | 'devin' | 'hermes' | 'custom-acp',
  scenario = 'normal',
  selected = false,
) {
  const directory = await mkdtemp('/tmp/forge-acp-production-')
  const db = new DatabaseSync(':memory:')
  migrate(db)
  if (selected) {
    await mkdir(join(directory, 'account'))
    db.prepare(
      'INSERT INTO harness_accounts(id,harness_key,label,kind,adapter_kind,home_path,order_index,created_at,config) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      'selected-account',
      profile,
      'Fixture',
      profile,
      'acp',
      join(directory, 'account'),
      0,
      0,
      JSON.stringify(
        profile === 'grok' ? { model: 'account-model', thinking: 'high' } : {},
      ),
    )
  }
  const account = selected
    ? new HarnessAccountStore(db).get('selected-account')
    : undefined
  const saved = createSession(db, {
    harness: profile,
    cwd: directory,
    title: 'ACP fixture',
    accountId: account?.id,
  })
  const resources = createNativeResources()
  const handles: HarnessHandle[] = []
  const report = join(directory, 'wire.jsonl')
  await writeFile(report, '')
  const uploads = new UploadStore(db, { dataDir: directory })
  cleanups.push(async () => {
    for (const handle of handles) await handle.kill()
    await resources.close()
    const rows = (await readFile(report, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    for (const row of rows.filter((row) => row.event === 'spawned'))
      await expectStopped(row.pid)
    uploads.close()
    db.close()
    await rm(directory, { recursive: true, force: true })
  })
  const path = join(directory, 'forge.toml')
  await writeFile(
    path,
    stringify({
      harness: {
        [profile]: {
          name: 'Fixture',
          command: fileURLToPath(
            new URL(
              scenario === 'late-child-retirement'
                ? '../harnesses/acp/__fixtures__/provider-agent.mjs'
                : '../harnesses/acp/__fixtures__/sdk-agent.mjs',
              import.meta.url,
            ),
          ),
          args: [...acpProviderDescriptors[profile].args],
          env: {
            FORGE_ACP_TEST_SCENARIO: scenario,
            FORGE_ACP_TEST_REPORT: report,
          },
          protocol: 'acp',
          ...(profile === 'custom-acp' ? { adapterKind: 'custom' } : {}),
          enabled: true,
        },
      },
    }),
  )
  const config = reconcileConfig(convertConfig(loadConfigSync(path)))
  const adapter = createProductionAcpAdapter(profile, {
    entry: config.harness[profile]!,
    db,
    account,
    resources,
    host: new AcpResourceHost(),
    loadAttachment: createNativeAttachmentLoader(db, directory),
  })
  const events: HarnessEvent[] = []
  const session: HarnessSession = {
    id: saved.id,
    provider: profile,
    accountId: account?.id ?? null,
    cwd: directory,
  }
  return {
    db,
    adapter,
    session,
    events,
    report,
    directory,
    async open(binding?: HarnessSession['binding']) {
      const handle = await (binding ? adapter.load! : adapter.spawn)(
        { ...session, binding },
        (event) => events.push(event),
      )
      handles.push(handle)
      return handle
    },
  }
}

it.each(['grok', 'gemini', 'devin', 'hermes', 'custom-acp'] as const)(
  'runs %s through the production typed journal and exact resume',
  async (profile) => {
    const f = await fixture(profile)
    const handle = await f.open()
    const receipt = await handle.prompt('hello')
    expect((await receipt.completion).status).toBe('completed')
    expect(f.events.some((event) => event.type === 'text_delta')).toBe(true)
    const terminal = f.db
      .prepare(
        "SELECT value FROM acp_records WHERE json_extract(value,'$.value.event.type')='turn_completed'",
      )
      .all()
    expect(terminal).toHaveLength(1)
    const binding = handle.binding!
    const before = f.db.prepare('SELECT * FROM acp_journals').get() as {
      journal_id: string
      committed_through: number
      writer_epoch: string
    }
    await handle.kill()
    if (profile === 'gemini') {
      expect(f.adapter.load).toBeUndefined()
      return
    }
    const resumed = await f.open(binding)
    const next = await resumed.prompt('again')
    expect((await next.completion).status).toBe('completed')
    const after = f.db
      .prepare('SELECT * FROM acp_journals')
      .get() as typeof before
    expect(after.journal_id).toBe(before.journal_id)
    expect(after.writer_epoch).not.toBe(before.writer_epoch)
    expect(after.committed_through).toBeGreaterThan(before.committed_through)
    const rows = (await readFile(f.report, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(rows.filter((row) => row.event === 'spawned')).toHaveLength(2)
    expect(
      rows.some(
        (row) =>
          row.event === 'received' &&
          row.frame.method === 'session/load' &&
          row.frame.params.sessionId === binding.providerSessionId,
      ),
    ).toBe(true)
  },
  20000,
)

it('persists the original permission before returning its exact wire answer', async () => {
  const f = await fixture('custom-acp', 'permission')
  const handle = await f.open()
  const receipt = await handle.prompt('permission')
  await vi.waitFor(() =>
    expect(
      f.events.some((event) => event.type === 'permission_requested'),
    ).toBe(true),
  )
  const event = f.events.find((event) => event.type === 'permission_requested')!
  if (event.type !== 'permission_requested')
    throw Error('Missing original permission')
  expect(
    f.db
      .prepare(
        "SELECT count(*) AS n FROM native_provider_records WHERE record_key LIKE 'acp-request:%'",
      )
      .get(),
  ).toEqual({ n: 1 })
  await handle.replyPermission!({
    type: 'selected',
    requestId: event.request.requestId,
    optionId: event.request.options[0]!.id,
  })
  expect((await receipt.completion).status).toBe('completed')
})

it.each(['grok', 'gemini', 'hermes'] as const)(
  'loads configured %s account authority through the production factory',
  async (profile) => {
    const f = await fixture(profile, 'normal', true)
    const handle = await f.open()
    expect(handle.binding?.accountId).toBe('selected-account')
    expect(
      (await (await handle.prompt('Scoped account')).completion).status,
    ).toBe('completed')
    const rows = (await readFile(f.report, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const spawn = rows.find((row) => row.event === 'spawned')
    expect(spawn.accountHome).toBe(join(f.directory, 'account'))
    if (profile === 'grok')
      expect(spawn.args).toEqual(
        expect.arrayContaining([
          '--model',
          'account-model',
          '--effort',
          'high',
        ]),
      )
  },
)

it('routes the browser permission answer through the original production session handle', async () => {
  const f = await fixture('custom-acp', 'permission')
  const bus = new EventBus(),
    interactions = new NativeInteractions(f.db, bus),
    questions = new QuestionManager({ db: f.db, bus })
  const manager = new SessionManager(
    f.db,
    bus,
    () => nativeHarness(f.adapter, undefined, interactions),
    60000,
    () => false,
    f.directory,
  )
  cleanups.push(() => manager.close())
  await manager.prompt(f.session.id, 'Permission')
  await vi.waitFor(() =>
    expect(questions.listPending(f.session.id)).toHaveLength(1),
  )
  const request = questions.listPending(f.session.id)[0]!
  const app = questionRoutes(questions, interactions)
  const result = await app.request(
    `/api/sessions/${f.session.id}/questions/${request.questionId}/answer`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        answers: {
          [request.questionId]: request.questions[0]!.options[0]!.label,
        },
      }),
    },
  )
  expect(result.status).toBe(200)
  await vi.waitFor(() =>
    expect(
      f.db
        .prepare("SELECT count(*) AS n FROM messages WHERE type='turn_end'")
        .get(),
    ).toEqual({ n: 1 }),
  )
  expect(f.db.prepare('SELECT status FROM native_interactions').get()).toEqual({
    status: 'submitted',
  })
})

it('serves original child-owned messages through the parent scope without creating child sessions', async () => {
  const f = await fixture('grok', 'late-child-retirement')
  const manager = new SessionManager(
    f.db,
    new EventBus(),
    () => nativeHarness(f.adapter),
    60000,
    () => false,
    f.directory,
  )
  cleanups.push(() => manager.close())
  await manager.prompt(f.session.id, 'Child')
  await vi.waitFor(() =>
    expect(
      f.db
        .prepare("SELECT count(*) AS n FROM messages WHERE type='turn_end'")
        .get(),
    ).toEqual({ n: 1 }),
  )
  await writeFile(join(f.directory, 'finish-child-1'), 'finish original child')
  let childId = ''
  await vi.waitFor(() => {
    const row = f.db
      .prepare(
        "SELECT json_extract(content,'$.childId') AS id FROM messages WHERE type='text_delta' AND json_extract(content,'$.childId') IS NOT NULL",
      )
      .get() as { id: string } | undefined
    expect(row).toBeDefined()
    childId = row!.id
  })
  const app = nativeChildRoutes(f.db)
  const response = await app.request(
    `/api/sessions/${f.session.id}/native-children/${childId}/messages?limit=1`,
  )
  expect(response.status).toBe(200)
  const page = (await response.json()) as {
    messages: Array<{
      sessionId: string
      content: { text: string; childId: string }
    }>
    cursor: number
    hasMore: boolean
  }
  expect(page.messages).toHaveLength(1)
  expect(page.messages[0]!.sessionId).toBe(f.session.id)
  expect(page.messages[0]!.content).toMatchObject({
    text: 'Late child-1.',
    childId,
  })
  expect(
    (
      await app.request(
        `/api/sessions/foreign/native-children/${childId}/messages`,
      )
    ).status,
  ).toBe(404)
  expect(f.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 1,
  })
  await manager.close()
  const history = f.db
    .prepare(
      "SELECT value FROM native_provider_state WHERE name='acp-child-history'",
    )
    .get() as { value: string }
  expect(JSON.parse(history.value).intervals[0].closed).toBe(true)
})

it('imports authoritative replay beside local history and deduplicates the same later snapshot', async () => {
  const f = await fixture('custom-acp', 'resume-replay')
  const first = await f.open()
  const binding = first.binding!
  await first.kill()
  appendMessage(f.db, {
    sessionId: f.session.id,
    turnId: 'local-turn',
    itemId: 'local-item',
    role: 'agent',
    type: 'text_delta',
    content: { type: 'text_delta', text: 'Existing local history' },
  })
  const resumed = await f.open(binding)
  const imported = f.db
    .prepare("SELECT * FROM messages WHERE turn_id LIKE 'acp-import:%'")
    .all()
  expect(imported).toHaveLength(70)
  expect(
    f.db
      .prepare("SELECT count(*) AS n FROM messages WHERE turn_id='local-turn'")
      .get(),
  ).toEqual({ n: 1 })
  expect(f.events.some((event) => event.type === 'text_delta')).toBe(false)
  await resumed.kill()
  const again = await f.open(binding)
  expect(
    f.db
      .prepare(
        "SELECT count(*) AS n FROM messages WHERE turn_id LIKE 'acp-import:%'",
      )
      .get(),
  ).toEqual({ n: 70 })
  expect(
    f.db
      .prepare(
        "SELECT count(*) AS n FROM acp_records WHERE json_extract(value,'$.value.kind')='replay'",
      )
      .get(),
  ).toEqual({ n: 140 })
  await again.kill()
})

it('keeps provider images durable across load and serves only their exact live session', async () => {
  const f = await fixture('custom-acp', 'media')
  const handle = await f.open()
  expect((await (await handle.prompt('image')).completion).status).toBe(
    'completed',
  )
  const event = f.events.find((event) => event.type === 'content_block')
  expect(event?.type).toBe('content_block')
  if (event?.type !== 'content_block' || !('artifactId' in event.block))
    throw Error('Missing image artifact')
  const app = acpArtifactRoutes(f.db)
  const url = `/api/sessions/${f.session.id}/acp-artifacts/${event.block.artifactId}`
  const response = await app.request(url)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('image/png')
  const bytes = new Uint8Array(await response.arrayBuffer())
  expect(bytes.slice(0, 8)).toEqual(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  )
  expect((await app.request(url.replace(f.session.id, 'foreign'))).status).toBe(
    404,
  )
  const binding = handle.binding!
  await handle.kill()
  const resumed = await f.open(binding)
  expect(new Uint8Array(await (await app.request(url)).arrayBuffer())).toEqual(
    bytes,
  )
  await resumed.kill()
  f.db.prepare('UPDATE sessions SET deleted_at=1 WHERE id=?').run(f.session.id)
  expect((await app.request(url)).status).toBe(404)
})

it('publishes plan status without an approval request', async () => {
  const f = await fixture('custom-acp', 'plan-updates')
  const handle = await f.open()
  const receipt = await handle.prompt('plan')
  await vi.waitFor(() =>
    expect(f.events.some((event) => event.type === 'plan')).toBe(true),
  )
  expect(f.events.some((event) => event.type === 'permission_requested')).toBe(
    false,
  )
  await writeFile(join(f.directory, 'finish-plan'), '')
  expect((await receipt.completion).status).toBe('completed')
  expect(f.events.filter((event) => event.type === 'plan')).toHaveLength(2)
})

import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { defaultConfig } from '../../config.js'
import { migrate } from '../../db/migrate.js'
import { createProject, createSession } from '../../db/queries.js'
import { EventBus } from '../../events/bus.js'
import { QuestionManager } from '../../acp/questions.js'
import { spawnMockAgent } from '../../../test/helpers/mock-agent.js'
import {
  acpProviderDescriptors,
  createCustomAcpAdapter,
  createDevinAdapter,
  createGeminiAdapter,
  createGrokAdapter,
  createHermesAdapter,
} from './providers.js'

const fakeDb = {
  prepare: () => ({ get: () => undefined, run: () => undefined }),
  exec: () => undefined,
}

const deps = () => ({
  db: fakeDb,
  bus: new EventBus(),
  questions: new QuestionManager({ db: fakeDb }),
})

describe('dedicated ACP provider catalog', () => {
  it('keeps provider commands and install guidance explicit', () => {
    expect(acpProviderDescriptors.grok.args).toEqual(['agent', 'stdio'])
    expect(acpProviderDescriptors.gemini.args).toEqual(['--experimental-acp'])
    expect(acpProviderDescriptors.hermes.install).toContain('ACP extra')
    expect(acpProviderDescriptors.devin.install).toContain('Install')
  })

  it('exposes each provider through its own constructor', () => {
    const config = defaultConfig(false).harness
    expect(createGrokAdapter(config.grok, deps())).toBeDefined()
    expect(createGeminiAdapter(config.gemini, deps())).toBeDefined()
    expect(
      createDevinAdapter({ ...config.grok, name: 'Devin' }, deps()),
    ).toBeDefined()
    expect(
      createHermesAdapter({ ...config.grok, name: 'Hermes' }, deps()),
    ).toBeDefined()
    expect(createCustomAcpAdapter(config.grok, deps())).toBeDefined()
  })

  it('runs a dedicated adapter against the ACP wire', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'acp', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'grok',
      title: 'ACP',
      cwd: '/tmp',
    })
    const command = spawnMockAgent()
    const handle = await createGrokAdapter(
      {
        ...defaultConfig(false).harness.grok,
        command: command.command,
        args: command.args,
        enabled: true,
      },
      { db, bus: new EventBus(), questions: new QuestionManager({ db }) },
    ).spawn(
      { id: session.id, cwd: '/tmp', harness: 'grok' },
      () => undefined,
      () => undefined,
    )
    await handle.prompt('wire check')
    await handle.kill()
  })
})

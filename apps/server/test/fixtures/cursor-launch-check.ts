import { join } from 'node:path'
import { captureLaunch } from '../../src/harnesses/cursor/launch.js'
import { cursorLimits } from '../../src/harnesses/cursor/limits.js'
const root = process.argv[2]
try {
  const captured = captureLaunch(
    {
      provider: 'cursor-test',
      selectionEpoch: 'fixture',
      harness: {
        name: 'Cursor',
        command: process.execPath,
        args: [],
        env: {},
        protocol: 'acp',
        adapterKind: 'native',
        enabled: true,
      },
      account: {
        id: 'test',
        harnessKey: 'cursor-test',
        kind: 'cursor',
        adapterKind: 'native',
        homePath: join(root, 'accounts/test'),
        disabledAt: null,
        label: 'Fixture',
        orderIndex: 0,
        createdAt: 0,
        lastUsedAt: null,
        identity: null,
        config: null,
      },
      credential: { type: 'api-key', apiKey: 'synthetic-key' },
      accountEnv: { CURSOR_API_KEY: undefined },
      settingSources: [],
    },
    join(root, 'state'),
    cursorLimits(),
  )
  process.stdout.write(
    JSON.stringify({
      captured: true,
      removedKey: captured.environment.CURSOR_API_KEY === undefined,
    }),
  )
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      captured: false,
      code: (error as { code?: string }).code ?? 'invalid',
    }),
  )
}

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const fixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/acp-mock-agent.ts',
)

export function spawnMockAgent(flags: Record<string, string | undefined> = {}) {
  return {
    command: 'bun',
    args: [fixture],
    env: {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(flags).map(([key, value]) => [
          `FORGE_MOCK_${key}`,
          value,
        ]),
      ),
      FORGE_MOCK_REQUEST_LOG_PATH: flags.REQUEST_LOG_PATH,
    },
  }
}

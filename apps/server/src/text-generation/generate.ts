import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessAccount } from '@forge/protocol/accounts'
import type { HarnessConfig } from '@forge/protocol/config'
import { accountEnv } from '../accounts/store.js'
import { inheritedCredentials } from '../harnesses/claude/index.js'

export type TextGenerationInput = {
  harness: string
  entry: HarnessConfig
  account?: HarnessAccount
  model?: string
  prompt: string
  timeoutMs?: number
}

/** Runs one prompt through a harness CLI and returns the reply text. */
export async function generateText(input: TextGenerationInput) {
  const cwd = await mkdtemp(join(tmpdir(), 'forge-text-'))
  try {
    if (input.harness === 'claude-code-acp') return await runClaude(input, cwd)
    if (input.harness === 'codex-acp') return await runCodex(input, cwd)
    throw new Error(`${input.harness} cannot generate text`)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

function runClaude(input: TextGenerationInput, cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...input.entry.env }
  if (input.account) {
    for (const name of inheritedCredentials) delete env[name]
    Object.assign(env, accountEnv('claude', input.account.homePath))
  }
  delete env.CLAUDECODE
  return run(
    input.entry.command || 'claude',
    [
      '--print',
      '--output-format',
      'text',
      '--no-session-persistence',
      '--tools',
      '',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      ...(input.model ? ['--model', input.model] : []),
    ],
    { cwd, env, stdin: input.prompt, timeoutMs: input.timeoutMs },
  )
}

async function runCodex(input: TextGenerationInput, cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...input.entry.env }
  if (input.account)
    Object.assign(env, accountEnv('codex', input.account.homePath))
  const output = join(cwd, 'reply.txt')
  await run(
    input.entry.command || 'codex',
    [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--color',
      'never',
      '-c',
      'model_reasoning_effort="low"',
      '--output-last-message',
      output,
      ...(input.model ? ['--model', input.model] : []),
      '-',
    ],
    { cwd, env, stdin: input.prompt, timeoutMs: input.timeoutMs },
  )
  return readFile(output, 'utf8')
}

function run(
  command: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    stdin: string
    timeoutMs?: number
  },
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? 60_000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) resolve(stdout)
      else
        reject(
          new Error(
            `${command} exited with ${signal ?? code}: ${stderr.trim().slice(-500)}`,
          ),
        )
    })
    child.stdin.end(options.stdin)
  })
}

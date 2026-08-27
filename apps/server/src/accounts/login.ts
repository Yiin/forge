import { spawn, type IPty } from 'node-pty'
import { accountEnv, HarnessAccountStore } from './store.js'
import { cleanPtyText } from '../pty/harness.js'
import type { EventBus } from '../events/bus.js'
import type { HarnessConfig } from '@forge/protocol/config'

export type LoginStatus =
  'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type LoginState = {
  status: LoginStatus
  startedAt: string | null
  finishedAt: string | null
  message: string | null
  output: string
  verificationUrl: string | null
  userCode: string | null
}
type Run = {
  state: LoginState
  pty?: IPty
  idleTimer?: ReturnType<typeof setTimeout>
}

const emptyState = (): LoginState => ({
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  message: null,
  output: '',
  verificationUrl: null,
  userCode: null,
})
const cliFor = (kind: string) =>
  kind === 'claude'
    ? 'claude'
    : kind === 'codex'
      ? 'codex'
      : kind === 'kimi'
        ? 'kimi'
        : kind === 'opencode'
          ? 'opencode'
          : null

const argsFor = (
  kind: string,
  input?: { provider?: string; method?: string },
) =>
  kind === 'claude'
    ? ['auth', 'login']
    : kind === 'codex'
      ? ['login', '--device-auth']
      : kind === 'kimi'
        ? ['login']
        : [
            'auth',
            'login',
            ...(input?.provider ? ['--provider', input.provider] : []),
            ...(input?.method ? ['--method', input.method] : []),
          ]

function tail(value: string) {
  return value.length <= 10_000 ? value : value.slice(-10_000)
}
function url(value: string) {
  return (
    value.match(/https:\/\/[^\s]+/i)?.[0]?.replace(/[),.;:'"]+$/, '') ?? null
  )
}
function code(value: string) {
  const matches = [
    ...value.matchAll(
      /\b(?:code|enter(?: the)? code)\s*(?:is|:|=)?\s*([a-z0-9][a-z0-9-]{3,19})/gi,
    ),
  ]
  const candidate = matches.at(-1)?.[1]
  return candidate && /[A-Z0-9-]/.test(candidate) ? candidate : null
}

export class LoginManager {
  private readonly runs = new Map<string, Run>()
  constructor(
    private readonly accounts: HarnessAccountStore,
    private readonly bus: EventBus,
    private readonly config: (harnessKey: string) => HarnessConfig | undefined,
    // The provider CLI owns the login flow; the harness command is an ACP
    // adapter (often npx) and must never be used to run `auth login`.
    private readonly cli: (kind: string) => string | null = cliFor,
  ) {}

  private publish(loginId: string, state: LoginState) {
    this.bus.publishEphemeral({
      type: 'harnessLoginUpdate',
      seq: null,
      loginId,
      state,
    })
  }
  get(loginId: string) {
    return this.runs.get(loginId)?.state
  }

  start(accountId: string, input?: { provider?: string; method?: string }) {
    const account = this.accounts.get(accountId)
    if (!account) throw new Error('Account not found')
    const entry = this.config(account.harnessKey)
    if (!entry)
      throw new Error(`Harness ${account.harnessKey} is not configured`)
    const command = this.cli(account.kind)
    if (!command)
      throw new Error(`No login command for account kind ${account.kind}`)
    const loginId = `login_${crypto.randomUUID().replaceAll('-', '')}`
    const run: Run = { state: emptyState() }
    this.runs.set(loginId, run)
    this.publish(loginId, run.state)
    try {
      run.pty = spawn(command, argsFor(account.kind, input), {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...entry.env,
          ...accountEnv(account.kind, account.homePath),
        } as Record<string, string>,
      })
    } catch (error) {
      this.finish(
        loginId,
        'failed',
        error instanceof Error ? error.message : String(error),
      )
      return loginId
    }
    run.state = {
      ...run.state,
      status: 'running',
      startedAt: new Date().toISOString(),
      message: 'Waiting for provider authentication.',
    }
    this.publish(loginId, run.state)
    const arm = () => {
      if (run.idleTimer) clearTimeout(run.idleTimer)
      run.idleTimer = setTimeout(
        () =>
          this.finish(
            loginId,
            'failed',
            'Provider login timed out after 10 minutes without output.',
          ),
        10 * 60 * 1000,
      )
    }
    arm()
    run.pty.onData((data) => {
      const output = tail(run.state.output + cleanPtyText(data))
      run.state = {
        ...run.state,
        output,
        verificationUrl: url(output) ?? run.state.verificationUrl,
        userCode: code(output) ?? run.state.userCode,
      }
      this.publish(loginId, run.state)
      arm()
    })
    run.pty.onExit(({ exitCode }) => {
      if (run.state.status === 'running')
        this.finish(
          loginId,
          exitCode === 0 ? 'succeeded' : 'failed',
          exitCode === 0
            ? 'Provider login completed.'
            : `Provider login exited with code ${exitCode}.`,
        )
    })
    return loginId
  }

  private finish(loginId: string, status: LoginStatus, message: string) {
    const run = this.runs.get(loginId)
    if (!run || (run.state.status !== 'idle' && run.state.status !== 'running'))
      return
    if (run.idleTimer) clearTimeout(run.idleTimer)
    run.state = {
      ...run.state,
      status,
      finishedAt: new Date().toISOString(),
      message,
    }
    this.publish(loginId, run.state)
    if (status !== 'succeeded' && run.pty) run.pty.kill()
  }
  respond(loginId: string, data: string) {
    const run = this.runs.get(loginId)
    if (!run || run.state.status !== 'running' || !run.pty)
      throw new Error('Provider login is not waiting for input')
    run.pty.write(`${data}\r`)
  }
  cancel(loginId: string) {
    this.finish(loginId, 'cancelled', 'Provider login was cancelled.')
  }
  close() {
    for (const id of this.runs.keys())
      if (this.runs.get(id)?.state.status === 'running') this.cancel(id)
  }
}

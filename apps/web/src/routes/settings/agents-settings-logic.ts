import type { HarnessConfig } from '@forge/protocol/config'
import { harnessMarkKind } from '../../components/settings/harness-mark-logic'
import { accountKindForHarness } from '../../lib/harness-accounts-logic'

export const LAST_ENABLED_REASON = 'At least one agent must stay enabled'

const BLURBS: Record<string, string> = {
  claude: "Anthropic's coding agent, driven through the Claude Code CLI.",
  codex: "OpenAI's coding agent, driven through the Codex CLI.",
  cursor: "Cursor's coding agent (cursor-agent CLI).",
  grok: "xAI's Grok Build agent (grok CLI).",
  hermes: "Nous Research's Hermes Agent (hermes CLI).",
  pi: 'The pi coding agent (pi CLI).',
  opencode: 'The OpenCode agent (opencode CLI).',
  kimi: "Moonshot's Kimi agent (kimi CLI).",
  gemini: "Google's Gemini CLI agent.",
  devin: "Cognition's Devin agent (devin CLI).",
}

/** What the health endpoint reports for one harness key. */
export type HarnessHealth = { installed: boolean; accountCount: number }

export type AgentRow = {
  key: string
  harness: HarnessConfig
  markKind: string
  blurb: string
  /** Null for harnesses without managed accounts. */
  accountCount: number | null
  installed: boolean
  installHint: string | null
  /** Why the switch cannot change right now, or null when it can. */
  lockedReason: string | null
}

/**
 * Config keys in config order. The `mock` harness is a test double, so it only
 * shows when it is the only harness configured.
 */
export function visibleHarnessKeys(config: Record<string, HarnessConfig>) {
  const keys = Object.keys(config)
  return keys.length === 1 ? keys : keys.filter((key) => key !== 'mock')
}

export function harnessBlurb(key: string, harness: HarnessConfig) {
  const kind = harnessMarkKind(key, harness)
  if (BLURBS[kind]) return BLURBS[kind]
  const tokens = [key, harness.command].join(' ').toLowerCase().split(/\W+/)
  if (tokens.includes('gemini')) return BLURBS.gemini
  return `Custom agent (${harness.protocol.toUpperCase()} protocol).`
}

/** Hint for a missing CLI; names the program, not its full path. */
export function installHint(command: string, enabled: boolean) {
  const cli = command.split(/[\\/]/).pop() || command
  return enabled
    ? `${cli} CLI not installed — turn it off or install it`
    : `Install the ${cli} CLI to enable`
}

export function accountCountLabel(count: number) {
  if (count === 0) return 'No accounts'
  return count === 1 ? '1 account' : `${count} accounts`
}

/**
 * Builds the rows in config order. A key the health endpoint does not report
 * yet (for example an agent added a moment ago) counts as installed, so the
 * page never blocks a toggle on missing data.
 *
 * Toggle rules: turning on needs the CLI; turning off is always allowed except
 * for the last enabled agent that can actually run.
 */
export function buildAgentRows(
  config: Record<string, HarnessConfig>,
  health: Record<string, HarnessHealth>,
): AgentRow[] {
  const keys = visibleHarnessKeys(config)
  const installedOf = (key: string) => health[key]?.installed ?? true
  const runnable = keys.filter(
    (key) => config[key].enabled && installedOf(key),
  ).length
  return keys.map((key) => {
    const harness = config[key]
    const installed = installedOf(key)
    const hint = installed
      ? null
      : installHint(harness.command, harness.enabled)
    let lockedReason: string | null = null
    if (!harness.enabled && !installed) lockedReason = hint
    else if (harness.enabled && installed && runnable === 1)
      lockedReason = LAST_ENABLED_REASON
    return {
      key,
      harness,
      markKind: harnessMarkKind(key, harness),
      blurb: harnessBlurb(key, harness),
      accountCount: accountKindForHarness(key, harness)
        ? (health[key]?.accountCount ?? 0)
        : null,
      installed,
      installHint: hint,
      lockedReason,
    }
  })
}

/** The full config map with one harness flipped, as PUT /api/harnesses wants. */
export function withHarnessEnabled(
  config: Record<string, HarnessConfig>,
  key: string,
  enabled: boolean,
) {
  return { ...config, [key]: { ...config[key], enabled } }
}

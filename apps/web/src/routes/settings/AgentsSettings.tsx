import { Link } from '@tanstack/react-router'
import { Plus, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { HarnessConfig } from '@forge/protocol/config'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { AddHarnessDialog } from '../../components/settings/AddHarnessDialog'
import { HarnessConfigDialog } from '../../components/settings/HarnessConfigDialog'
import { HarnessMark } from '../../components/settings/HarnessMark'
import {
  SettingsCard,
  SettingsCardRow,
  SettingsIconTile,
  SettingsMeta,
  SettingsPage,
  SettingsSkeletonCard,
  SettingsStrip,
} from '../../components/settings/settings-layout'
import { listHarnessHealth } from '../../lib/accounts-api'
import { api } from '../../lib/api'
import {
  accountCountLabel,
  buildAgentRows,
  withHarnessEnabled,
  type AgentRow,
  type HarnessHealth,
} from './agents-settings-logic'

type Config = Record<string, HarnessConfig>

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

async function fetchHealth() {
  const entries = await listHarnessHealth()
  return Object.fromEntries(
    entries.map((entry) => [
      entry.key,
      { installed: entry.installed, accountCount: entry.accountCount },
    ]),
  ) as Record<string, HarnessHealth>
}

export function AgentsSettings() {
  const [config, setConfig] = useState<Config | null>(null)
  const [health, setHealth] = useState<Record<string, HarnessHealth>>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [configuring, setConfiguring] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const load = async () => {
    setLoadError(null)
    setConfig(null)
    try {
      const [nextConfig, nextHealth] = await Promise.all([
        api.listHarnesses() as Promise<Config>,
        fetchHealth(),
      ])
      setHealth(nextHealth)
      setConfig(nextConfig)
    } catch (cause) {
      setLoadError(errorText(cause))
    }
  }
  useEffect(() => {
    void load()
  }, [])

  /** Saves the full map; the caller handles errors. */
  const saveConfig = async (next: Config) => {
    await api.saveHarnesses(next)
    setConfig(next)
    setSaveError(null)
    // A new or edited command changes what the CLI probe finds.
    void fetchHealth()
      .then(setHealth)
      .catch(() => {})
  }

  const toggle = async (row: AgentRow, enabled: boolean) => {
    if (!config) return
    const next = withHarnessEnabled(config, row.key, enabled)
    setConfig(next)
    try {
      await api.saveHarnesses(next)
      setSaveError(null)
    } catch (cause) {
      setConfig((current) =>
        current ? withHarnessEnabled(current, row.key, !enabled) : current,
      )
      setSaveError(
        `Could not turn ${enabled ? 'on' : 'off'} ${row.harness.name}: ${errorText(cause)}`,
      )
    }
  }

  const rows = config ? buildAgentRows(config, health) : []
  const configured = configuring && config ? config[configuring] : null

  return (
    <SettingsPage
      title="Agents"
      subtitle="Choose which coding agents the composer offers. Agents whose CLI isn't installed on this server can't be enabled."
      actions={
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground"
          disabled={!config}
          onClick={() => setAddOpen(true)}
        >
          <Plus />
          Add agent
        </Button>
      }
    >
      {loadError ? (
        <SettingsStrip tone="error" onRetry={() => void load()}>
          Could not load agents: {loadError}
        </SettingsStrip>
      ) : !config ? (
        <SettingsSkeletonCard />
      ) : (
        <>
          {saveError && (
            <SettingsStrip tone="error" onDismiss={() => setSaveError(null)}>
              {saveError}
            </SettingsStrip>
          )}
          <SettingsCard>
            {rows.map((row) => (
              <AgentRowView
                key={row.key}
                row={row}
                onToggle={(enabled) => void toggle(row, enabled)}
                onConfigure={() => setConfiguring(row.key)}
              />
            ))}
            {rows.length === 0 && (
              <p className="px-5 py-8 text-center text-[13px] text-muted-foreground/70">
                No agents configured yet.
              </p>
            )}
          </SettingsCard>
        </>
      )}
      {configuring && configured && (
        <HarnessConfigDialog
          key={configuring}
          harness={configured}
          onOpenChange={(open) => {
            if (!open) setConfiguring(null)
          }}
          onSave={(next) => saveConfig({ ...config, [configuring]: next })}
        />
      )}
      <AddHarnessDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        existingIds={Object.keys(config ?? {})}
        onAdd={(id, harness) => {
          if (!config) return
          saveConfig({ ...config, [id]: harness }).catch((cause) =>
            setSaveError(`Could not add ${harness.name}: ${errorText(cause)}`),
          )
        }}
      />
    </SettingsPage>
  )
}

function AgentRowView({
  row,
  onToggle,
  onConfigure,
}: {
  row: AgentRow
  onToggle: (enabled: boolean) => void
  onConfigure: () => void
}) {
  const { harness, lockedReason } = row
  const hintId = `agent-${row.key}-hint`
  const reasonId = `agent-${row.key}-locked`
  // The install hint is already on screen; only the last-agent rule needs
  // its own hidden description.
  const hiddenReason = lockedReason && lockedReason !== row.installHint
  const toggle = (
    <Switch
      aria-label={`Enable ${harness.name}`}
      aria-describedby={
        hiddenReason ? reasonId : lockedReason ? hintId : undefined
      }
      aria-disabled={lockedReason ? true : undefined}
      checked={harness.enabled}
      readOnly={Boolean(lockedReason)}
      onCheckedChange={onToggle}
      className={cn(
        'relative pointer-coarse:after:absolute pointer-coarse:after:-inset-3',
        lockedReason && 'cursor-not-allowed',
        // A dimmed row already fades the switch; do not fade it twice.
        lockedReason && row.installed && 'opacity-35',
      )}
    />
  )
  return (
    <SettingsCardRow
      dimmed={!row.installed}
      className="max-sm:gap-2.5 max-sm:px-4"
    >
      <SettingsIconTile>
        <HarnessMark kind={row.markKind} />
      </SettingsIconTile>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{harness.name}</p>
        <SettingsMeta>
          <span>{row.blurb}</span>
          {row.accountCount !== null && (
            <Link
              to="/settings/accounts"
              className="rounded-sm whitespace-nowrap underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {accountCountLabel(row.accountCount)}
            </Link>
          )}
          {row.installHint && (
            <span id={hintId} className="text-warning">
              {row.installHint}
            </span>
          )}
        </SettingsMeta>
      </div>
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0 text-xs text-muted-foreground"
        aria-label={`Configure ${harness.name}`}
        onClick={onConfigure}
      >
        <SlidersHorizontal />
        <span className="max-sm:hidden">Configure</span>
      </Button>
      {lockedReason ? (
        <Tooltip>
          <TooltipTrigger render={toggle} />
          <TooltipContent>{lockedReason}</TooltipContent>
        </Tooltip>
      ) : (
        toggle
      )}
      {hiddenReason && (
        <span id={reasonId} className="sr-only">
          {lockedReason}
        </span>
      )}
    </SettingsCardRow>
  )
}

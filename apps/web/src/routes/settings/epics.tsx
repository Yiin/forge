import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useSettingsStore } from '../../stores/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RolePolicyEditor } from '../../components/settings/RolePolicyEditor'
import {
  ErrorRow,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '../settings-pages-implementation'
import { validateEpicDefaults, type EpicDefaults } from '../epic-settings-logic'

const initialDefaults: EpicDefaults = {
  workerCount: 3,
  mode: 'pool',
  rolePolicy: {
    roles: {
      'iteration-worker': 'default',
      'triage-control': 'default',
      'title-generation': 'default',
    },
    tiers: { default: [{ harness: 'claude-code-acp' }] },
  },
}

export function EpicSettings() {
  const [defaults, setDefaults] = useState(initialDefaults)
  const [saved, setSaved] = useState(initialDefaults)
  const [harnesses, setHarnesses] = useState<Record<string, { name: string }>>(
    {},
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const invalidRefs = useRef<Record<string, HTMLElement | null>>({})
  const scope = useSettingsStore((state) => state.scopes.epics)
  const load = useSettingsStore((state) => state.load)
  const save = useSettingsStore((state) => state.save)
  const retry = useSettingsStore((state) => state.retry)
  const dirty = JSON.stringify(defaults) !== JSON.stringify(saved)
  useEffect(() => {
    void Promise.all([load(), api.listHarnesses()])
      .then(([, available]) => {
        const value = useSettingsStore.getState().settings as {
          epicDefaults?: Partial<EpicDefaults>
        }
        const next = {
          ...initialDefaults,
          ...value.epicDefaults,
          rolePolicy:
            value.epicDefaults?.rolePolicy ?? initialDefaults.rolePolicy,
        }
        setDefaults(next)
        setSaved(next)
        setHarnesses(available as Record<string, { name: string }>)
      })
      .catch((cause: unknown) =>
        setLoadError(cause instanceof Error ? cause.message : String(cause)),
      )
  }, [load])
  const update = (next: EpicDefaults) => {
    setDefaults(next)
    setErrors({})
  }
  const saveChanges = () => {
    const nextErrors = validateEpicDefaults(defaults, Object.keys(harnesses))
    setErrors(nextErrors)
    const first = Object.keys(nextErrors)[0]
    if (first) {
      invalidRefs.current[first]?.focus()
      return
    }
    void save('epics', { epicDefaults: defaults }).then(() =>
      setSaved(defaults),
    )
  }
  const status =
    scope.status === 'saving'
      ? 'Saving...'
      : scope.status === 'error'
        ? scope.error
        : dirty
          ? 'Unsaved changes'
          : scope.status === 'saved'
            ? 'Saved.'
            : null
  return (
    <SettingsPage title="Epics" subtitle="Defaults for the epic runner.">
      {loadError && (
        <ErrorRow onRetry={() => window.location.reload()}>
          Could not load epic defaults: {loadError}
        </ErrorRow>
      )}
      {scope.status === 'error' && (
        <ErrorRow onRetry={() => void retry('epics')}>
          Could not save: {scope.error}
        </ErrorRow>
      )}
      <SettingsSection
        title="Run model"
        description="Choose how Forge runs an epic."
      >
        <SettingsRow
          label="Worker count"
          description="Number of workers in the run."
        >
          <Input
            className="w-24"
            aria-label="Worker count"
            type="number"
            min="1"
            value={defaults.workerCount}
            onChange={(e) =>
              update({ ...defaults, workerCount: Number(e.target.value) })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Default mode"
          description="How workers run by default."
        >
          <Select
            value={defaults.mode}
            onValueChange={(value) => {
              if (value === 'pool' || value === 'serial' || value === 'auto')
                update({ ...defaults, mode: value })
            }}
          >
            <SelectTrigger className="w-32" aria-label="Default mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pool">Pool</SelectItem>
              <SelectItem value="serial">Serial</SelectItem>
              <SelectItem value="auto">Auto</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Gate command"
          description="Command used to check the work."
        >
          <Input
            className="w-64 font-mono text-sm"
            aria-label="Gate command"
            value={
              typeof defaults.gateCommand === 'string'
                ? defaults.gateCommand
                : (defaults.gateCommand ?? []).join('\n')
            }
            placeholder="bun run test"
            ref={(node) => {
              invalidRefs.current.gateCommand = node
            }}
            onChange={(e) =>
              update({ ...defaults, gateCommand: e.target.value || undefined })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Install command"
          description="Command used before the gate."
        >
          <Input
            className="w-64 font-mono text-sm"
            aria-label="Install command"
            value={
              typeof defaults.installCommand === 'string'
                ? defaults.installCommand
                : (defaults.installCommand ?? []).join('\n')
            }
            placeholder="bun install"
            ref={(node) => {
              invalidRefs.current.installCommand = node
            }}
            onChange={(e) =>
              update({
                ...defaults,
                installCommand: e.target.value || undefined,
              })
            }
          />
        </SettingsRow>
      </SettingsSection>
      <RolePolicyEditor
        policy={defaults.rolePolicy}
        harnessKeys={Object.keys(harnesses)}
        errors={errors}
        onChange={(rolePolicy) => update({ ...defaults, rolePolicy })}
        onReset={() =>
          update({ ...defaults, rolePolicy: initialDefaults.rolePolicy })
        }
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span
          className={
            scope.status === 'error'
              ? 'text-sm text-destructive'
              : 'text-sm text-muted-foreground'
          }
          role="status"
        >
          {status}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!dirty || scope.status === 'saving'}
          onClick={() => {
            setDefaults(saved)
            setErrors({})
          }}
        >
          Reset
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || scope.status === 'saving'}
          onClick={saveChanges}
        >
          Save changes
        </Button>
      </div>
    </SettingsPage>
  )
}

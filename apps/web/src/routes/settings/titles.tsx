import { useEffect, useState } from 'react'
import {
  canGenerateText,
  textGenerationHarnesses,
  type TextModel,
} from '@forge/protocol/config'
import type { ModelEntry } from '@forge/protocol/models'
import {
  accountsApi,
  type Account,
  type HarnessPickerEntry,
} from '../../lib/accounts-api'
import { useSettingsStore } from '../../stores/settings'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  ErrorRow,
  RequestState,
} from '../../components/settings/settings-layout'
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '../settings-pages-implementation'

/** Select values cannot be empty, so "no choice" gets a named value. */
const AUTO = 'auto'
const defaultChoice: TextModel = { harness: 'claude-code-acp' }

export function TitleSettings() {
  const settings = useSettingsStore((state) => state.settings)
  const scope = useSettingsStore((state) => state.scopes.titles)
  const load = useSettingsStore((state) => state.load)
  const save = useSettingsStore((state) => state.save)
  const retry = useSettingsStore((state) => state.retry)
  const [harnesses, setHarnesses] = useState<HarnessPickerEntry[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [models, setModels] = useState<ModelEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  useEffect(() => {
    void Promise.all([
      load(),
      accountsApi.listHarnesses(),
      accountsApi.listAccounts(),
    ])
      .then(([, harnessList, accountList]) => {
        setHarnesses(harnessList)
        setAccounts(accountList)
      })
      .catch((cause: unknown) =>
        setLoadError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setLoading(false))
  }, [load])

  const choice = settings.titleModel ?? defaultChoice
  const usable = harnesses.filter(
    (harness) => harness.enabled && canGenerateText(harness.key),
  )
  const harnessAccounts = accounts.filter(
    (account) => account.harnessKey === choice.harness && account.enabled,
  )
  // The model list comes from the chosen account, or the first one the
  // server would pick when no account is chosen.
  const modelAccount = choice.accountId ?? harnessAccounts[0]?.id
  useEffect(() => {
    setModels([])
    if (!modelAccount) return
    void accountsApi
      .getModels(modelAccount)
      .then((catalog) => setModels(catalog.models))
      .catch(() => undefined)
  }, [modelAccount])

  const commit = (patch: Parameters<typeof save>[1]) =>
    void save('titles', patch).catch(() => undefined)
  const setChoice = (next: TextModel) => commit({ titleModel: next })
  const defaultModel = canGenerateText(choice.harness)
    ? textGenerationHarnesses[choice.harness].defaultModel
    : undefined
  const modelItems = [
    {
      value: AUTO,
      label: defaultModel ? `Default (${defaultModel})` : 'Agent default',
    },
    ...models.map((model) => ({ value: model.id, label: model.displayName })),
    ...(choice.model && !models.some((model) => model.id === choice.model)
      ? [{ value: choice.model, label: choice.model }]
      : []),
  ]
  const accountItems = [
    { value: AUTO, label: 'First available account' },
    ...harnessAccounts.map((account) => ({
      value: account.id,
      label: account.label || account.email || account.id,
    })),
  ]
  const harnessItems = usable.map((harness) => ({
    value: harness.key,
    label: harness.name,
  }))

  return (
    <SettingsPage
      title="Titles"
      subtitle="A small model renames each chat session after every reply."
    >
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {loadError && <ErrorRow>Could not load: {loadError}</ErrorRow>}
      {!loading && !loadError && scope.status !== 'idle' && (
        <RequestState
          state={scope.status === 'dirty' ? 'saving' : scope.status}
          error={scope.error}
          onRetry={
            scope.status === 'error' ? () => void retry('titles') : undefined
          }
        />
      )}
      <SettingsSection
        title="Session titles"
        description="Epic runs use the title generation role in Epics settings."
      >
        <SettingsRow
          label="Generate titles"
          description="Off keeps the title made from your first message."
        >
          <Switch
            checked={settings.titleGeneration}
            aria-label="Generate session titles"
            onCheckedChange={(checked) => commit({ titleGeneration: checked })}
          />
        </SettingsRow>
        <SettingsRow
          label="Agent"
          description="Only agents that can answer one prompt without tools."
        >
          <Select
            value={choice.harness}
            items={harnessItems}
            disabled={!settings.titleGeneration}
            onValueChange={(value) => {
              if (value) setChoice({ harness: value })
            }}
          >
            <SelectTrigger className="w-48" aria-label="Title agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {harnessItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label="Account" description="The account that pays.">
          <Select
            value={choice.accountId ?? AUTO}
            items={accountItems}
            disabled={!settings.titleGeneration}
            onValueChange={(value) =>
              setChoice({
                harness: choice.harness,
                accountId: value && value !== AUTO ? value : undefined,
              })
            }
          >
            <SelectTrigger className="w-48" aria-label="Title account">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {accountItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Model"
          description="Pick a small, fast model. Titles run after every reply."
        >
          <Select
            value={choice.model ?? AUTO}
            items={modelItems}
            disabled={!settings.titleGeneration}
            onValueChange={(value) =>
              setChoice({
                ...choice,
                model: value && value !== AUTO ? value : undefined,
              })
            }
          >
            <SelectTrigger className="w-48" aria-label="Title model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modelItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  )
}

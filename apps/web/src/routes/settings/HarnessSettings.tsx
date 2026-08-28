import { LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type * as React from 'react'
import { toast } from 'sonner'
import type { HarnessConfig } from '@forge/protocol/config'
import type { HarnessAccountSnapshot } from '@forge/protocol/accounts'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { api } from '../../lib/api'
import type { Account } from '../../lib/accounts-api'
import {
  createAccount,
  deleteAccount,
  getAccountsDir,
  listAccounts,
  listHarnessStatus,
  loginStart,
  reorderAccounts,
  updateAccount,
} from '../../lib/accounts-api'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  accountKindForHarness,
  moveAccount,
  orderAccountRows,
} from '../../lib/harness-accounts-logic'
import { AccountLoginDialog } from '../../components/settings/AccountLoginDialog'
import { AccountSignOutDialog } from '../../components/settings/AccountSignOutDialog'
import { AddHarnessDialog } from '../../components/settings/AddHarnessDialog'
import { HarnessAccountCard } from '../../components/settings/HarnessAccountCard'
import {
  SettingsPage,
  SettingsSection,
} from '../../components/settings/settings-layout'

type Harness = HarnessConfig
type LoginTarget = {
  id: string
  name: string
  start: Awaited<ReturnType<typeof loginStart>>
}

type LoginOptions = {
  id: string
  name: string
  kind: string
  provider: string
  method: string
}

function LoginOptionsDialog({
  options,
  onOpenChange,
  onSubmit,
}: {
  options: LoginOptions
  onOpenChange: (open: boolean) => void
  onSubmit: (provider: string, method: string) => void
}) {
  const [provider, setProvider] = useState(options.provider)
  const [method, setMethod] = useState(options.method)
  const methods =
    options.kind === 'pi' ? ['oauth', 'api-key'] : ['oauth', 'api-key']
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sign in to {options.name}</DialogTitle>
          <DialogDescription>
            Choose the provider and authentication method.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Label>Provider</Label>
          <Input
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            placeholder="Provider name"
          />
          <Label>Authentication method</Label>
          <Select value={method} onValueChange={setMethod}>
            <SelectTrigger>
              <SelectValue placeholder="Select method" />
            </SelectTrigger>
            <SelectContent>
              {methods.map((method) => (
                <SelectItem key={method} value={method}>
                  {method}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit(provider.trim(), method)}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function HarnessGroupEditor({
  harness,
  onSave,
}: {
  harness: Harness
  onSave: (next: Harness) => void
}) {
  return (
    <div className="mt-2 grid gap-2 text-xs font-normal text-muted-foreground">
      <label className="grid gap-1">
        Command
        <Input
          className="h-8 font-mono text-xs"
          value={harness.command}
          onChange={(event) =>
            onSave({ ...harness, command: event.target.value })
          }
        />
      </label>
      <label className="grid gap-1">
        Arguments
        <Input
          className="h-8 font-mono text-xs"
          value={harness.args.join('\n')}
          onChange={(event) =>
            onSave({
              ...harness,
              args: event.target.value.split('\n').filter(Boolean),
            })
          }
        />
      </label>
      <fieldset className="grid gap-2">
        <legend>Environment variables</legend>
        {Object.entries(harness.env).map(([key, value]) => (
          <label className="grid gap-1" key={key}>
            <code>{key}</code>
            <Input
              className="h-8 font-mono text-xs"
              value={value}
              onChange={(event) =>
                onSave({
                  ...harness,
                  env: { ...harness.env, [key]: event.target.value },
                })
              }
            />
          </label>
        ))}
      </fieldset>
      <p>
        Protocol: <code>{harness.protocol.toUpperCase()}</code>
      </p>
      <p>These harness settings apply to every account in this group.</p>
    </div>
  )
}
const labels: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  opencode: 'OpenCode',
  grok: 'Grok',
  pi: 'Pi',
}

export function HarnessSettings() {
  const [config, setConfig] = useState<Record<string, Harness>>({})
  const [snapshots, setSnapshots] = useState<HarnessAccountSnapshot[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [addOpen, setAddOpen] = useState(false)
  const [login, setLogin] = useState<LoginTarget | null>(null)
  const [loginOptions, setLoginOptions] = useState<LoginOptions | null>(null)
  const [signOut, setSignOut] = useState<{
    id: string
    name: string
    kind: string
    home: string | null
  } | null>(null)
  const [accountsDir, setAccountsDir] = useState<string | null>(null)
  const setBusyState = (value: React.SetStateAction<Set<string>>) =>
    setBusy(value)
  const isAdding = [...busy].some((key) => key.startsWith('add:'))
  const snapshotFor = (id: string) =>
    snapshots.find((item) => item.accountId === id)
  const refresh = async (initial = false) => {
    try {
      const [next, nextAccounts] = await Promise.all([
        listHarnessStatus(),
        listAccounts(),
      ])
      setSnapshots(next)
      setAccounts(nextAccounts)
      setCheckedAt(
        next.reduce<string | null>(
          (latest, item) =>
            !latest || item.checkedAt > latest ? item.checkedAt : latest,
          null,
        ),
      )
      setError(null)
    } catch (cause) {
      if (initial)
        setError(cause instanceof Error ? cause.message : String(cause))
      else toast.error('Could not refresh harness status')
    }
  }
  const load = async () => {
    try {
      const next = await api.listHarnesses()
      setConfig(next as Record<string, Harness>)
      setAccountsDir((await getAccountsDir().catch(() => null)) ?? null)
      await refresh(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void refresh(), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const save = async (
    next: Record<string, Harness>,
    message = 'Could not save harness settings',
  ) => {
    try {
      await api.saveHarnesses(next)
      setConfig(next)
      return true
    } catch (cause) {
      toast.error(message, {
        description: cause instanceof Error ? cause.message : String(cause),
      })
      return false
    }
  }
  const rowsFor = (kind: string) => {
    const accountIds = snapshots
      .filter((item) => item.harnessKind === kind)
      .map((item) => item.accountId)
    return orderAccountRows(
      accountIds
        .map((id) => ({
          accountId: id,
          harness: config[kind],
          availability: 'available' as const,
        }))
        .filter(
          (
            row,
          ): row is {
            accountId: string
            harness: Harness
            availability: 'available'
          } => Boolean(row.harness),
        ),
      accountIds,
    )
  }
  const addManagedAccount = async (groupKey: string) => {
    if (isAdding) return
    const accountKind = accountKindForHarness(groupKey, config[groupKey])
    if (!accountKind) return
    setBusyState((current) => new Set(current).add(`add:${groupKey}`))
    const number =
      snapshots.filter((item) => item.harnessKind === groupKey).length + 1
    const name = `${labels[accountKind]} Account ${number}`
    try {
      const account = await createAccount({
        harnessKey: groupKey,
        label: name,
        kind: accountKind,
      })
      try {
        setLogin({
          id: account.id,
          name,
          start: await loginStart({ accountId: account.id }),
        })
      } catch {
        toast.error(`${name} was added, but sign-in did not start`, {
          description: 'Open the account card and try Sign in again.',
        })
      }
      await refresh()
    } catch (cause) {
      toast.error(`Could not add ${name}`, {
        description: cause instanceof Error ? cause.message : String(cause),
      })
    } finally {
      setBusyState((current) => {
        const next = new Set(current)
        next.delete(`add:${groupKey}`)
        return next
      })
    }
  }
  const reorder = async (
    rows: ReturnType<typeof rowsFor>,
    id: string,
    direction: 'up' | 'down',
  ) => {
    const moved = moveAccount(rows, id, direction)
    if (!moved) return
    setBusyState((current) => new Set(current).add(`reorder:${id}`))
    try {
      await reorderAccounts(moved.map((row) => row.accountId))
      await refresh()
    } catch {
      toast.error('Could not save account order')
    } finally {
      setBusyState((current) => {
        const next = new Set(current)
        next.delete(`reorder:${id}`)
        return next
      })
    }
  }
  const startLogin = async (
    id: string,
    name: string,
    provider?: string,
    method?: string,
  ) => {
    setBusyState((current) => new Set(current).add(`sign-in:${id}`))
    try {
      const start = await loginStart({ accountId: id, provider, method })
      if (provider) {
        const account = accounts.find((item) => item.id === id)
        await updateAccount(id, {
          config: { ...account?.config, provider },
        })
        setAccounts((current) =>
          current.map((item) =>
            item.id === id
              ? { ...item, config: { ...item.config, provider } }
              : item,
          ),
        )
      }
      setLogin({ id, name, start })
    } catch {
      toast.error(`Could not sign in to ${name}`)
    } finally {
      setBusyState((current) => {
        const next = new Set(current)
        next.delete(`sign-in:${id}`)
        return next
      })
    }
  }
  const signIn = async (id: string, name: string) => {
    const account = accounts.find((item) => item.id === id)
    if (account && (account.kind === 'opencode' || account.kind === 'pi')) {
      setLoginOptions({
        id,
        name,
        kind: account.kind,
        provider: account.config?.provider ?? '',
        method: 'oauth',
      })
      return
    }
    await startLogin(id, name)
  }
  const checked = checkedAt
    ? Number.isNaN(Date.parse(checkedAt))
      ? 'unavailable'
      : `${Math.max(0, Math.floor((Date.now() - Date.parse(checkedAt)) / 1000))}s ago`
    : null
  const kinds = [
    ...new Set([
      ...Object.keys(config),
      ...snapshots.map((item) => item.harnessKind),
    ]),
  ]
  return (
    <TooltipProvider>
      <SettingsPage
        title="Harnesses"
        subtitle="Manage harness commands and account credential homes."
      >
        <div className="flex flex-col gap-6">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/60">
              Harnesses
            </h2>
            <div className="flex items-center gap-1.5">
              {checked && (
                <span className="text-xs text-muted-foreground">
                  Checked{' '}
                  <span className="font-mono tabular-nums">
                    {checked.split(' ')[0]}
                  </span>
                  {checked.includes(' ')
                    ? ` ${checked.slice(checked.indexOf(' ') + 1)}`
                    : ''}
                </span>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Add harness"
                    disabled={isAdding}
                    onClick={() => setAddOpen(true)}
                  >
                    <Plus className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Add harness</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Refresh harness status"
                    disabled={busy.has('refresh')}
                    onClick={() => {
                      setBusyState((current) => new Set(current).add('refresh'))
                      void refresh().finally(() =>
                        setBusyState((current) => {
                          const next = new Set(current)
                          next.delete('refresh')
                          return next
                        }),
                      )
                    }}
                  >
                    {busy.has('refresh') ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refresh harness status</TooltipContent>
              </Tooltip>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              Could not load harness settings: {error}{' '}
              <Button variant="link" size="sm" onClick={() => void load()}>
                Retry
              </Button>
            </p>
          )}
          {!error &&
            kinds.map((kind) => {
              const rows = rowsFor(kind)
              return (
                <SettingsSection
                  key={kind}
                  title={config[kind]?.name ?? labels[kind] ?? kind}
                  description={
                    <HarnessGroupEditor
                      harness={config[kind]!}
                      onSave={(next) => void save({ ...config, [kind]: next })}
                    />
                  }
                  headerAction={
                    accountKindForHarness(kind, config[kind]) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isAdding}
                        onClick={() => void addManagedAccount(kind)}
                      >
                        {busy.has(`add:${kind}`) ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <Plus />
                        )}{' '}
                        Add account
                      </Button>
                    ) : null
                  }
                >
                  {rows.length === 0 ? (
                    <Empty className="border-0 py-10">
                      <EmptyHeader>
                        <EmptyTitle>No accounts</EmptyTitle>
                        <EmptyDescription>
                          Add an account to use this harness.
                        </EmptyDescription>
                      </EmptyHeader>
                      <EmptyContent>
                        {accountKindForHarness(kind, config[kind]) && (
                          <Button
                            size="sm"
                            onClick={() => void addManagedAccount(kind)}
                          >
                            <Plus /> Add account
                          </Button>
                        )}
                      </EmptyContent>
                    </Empty>
                  ) : (
                    rows.map((row) => {
                      const name =
                        snapshotFor(row.accountId)?.displayName || row.accountId
                      const accountRows = rows
                      const accountIndex = accountRows.findIndex(
                        (r) => r.accountId === row.accountId,
                      )
                      return (
                        <HarnessAccountCard
                          key={row.accountId}
                          accountId={row.accountId}
                          harness={row.harness}
                          snapshot={snapshotFor(row.accountId)}
                          accountKind={
                            accounts.find((a) => a.id === row.accountId)
                              ?.kind ?? kind
                          }
                          homePath={
                            accounts.find((a) => a.id === row.accountId)
                              ?.homePath ?? null
                          }
                          label={
                            accounts.find((a) => a.id === row.accountId)
                              ?.label ?? name
                          }
                          config={
                            accounts.find((a) => a.id === row.accountId)
                              ?.config ?? null
                          }
                          isExpanded={expanded[row.accountId] ?? false}
                          onExpandedChange={(open) =>
                            setExpanded((current) => ({
                              ...current,
                              [row.accountId]: open,
                            }))
                          }
                          onUpdateAccount={async (patch) => {
                            try {
                              const updated = await updateAccount(
                                row.accountId,
                                patch,
                              )
                              setAccounts((current) =>
                                current.map((account) =>
                                  account.id === row.accountId
                                    ? {
                                        ...account,
                                        ...(patch.label
                                          ? { label: patch.label }
                                          : {}),
                                        ...(patch.config !== undefined
                                          ? { config: patch.config }
                                          : {}),
                                        ...(patch.disabled !== undefined
                                          ? { enabled: !patch.disabled }
                                          : {}),
                                      }
                                    : account,
                                ),
                              )
                              return Boolean(updated)
                            } catch (cause) {
                              toast.error('Could not save account settings', {
                                description:
                                  cause instanceof Error
                                    ? cause.message
                                    : String(cause),
                              })
                              return false
                            }
                          }}
                          onDelete={async () => {
                            try {
                              await deleteAccount(row.accountId)
                              await refresh()
                            } catch {
                              toast.error(`Could not delete ${name}`)
                            }
                          }}
                          isSettingsDisabled={isAdding}
                          authActionBusy={
                            busy.has(`sign-in:${row.accountId}`)
                              ? 'sign-in'
                              : busy.has(`sign-out:${row.accountId}`)
                                ? 'sign-out'
                                : null
                          }
                          onSignIn={() => void signIn(row.accountId, name)}
                          onSignOut={() =>
                            setSignOut({
                              id: row.accountId,
                              name,
                              kind:
                                accounts.find((a) => a.id === row.accountId)
                                  ?.kind ??
                                snapshotFor(row.accountId)?.harnessKind ??
                                kind,
                              home:
                                accounts.find((a) => a.id === row.accountId)
                                  ?.storageDir ?? null,
                            })
                          }
                          reorder={
                            accountRows.length > 1
                              ? {
                                  onMoveUp:
                                    accountIndex > 0
                                      ? () =>
                                          void reorder(
                                            rows,
                                            row.accountId,
                                            'up',
                                          )
                                      : undefined,
                                  onMoveDown:
                                    accountIndex < accountRows.length - 1
                                      ? () =>
                                          void reorder(
                                            rows,
                                            row.accountId,
                                            'down',
                                          )
                                      : undefined,
                                }
                              : undefined
                          }
                        />
                      )
                    })
                  )}
                </SettingsSection>
              )
            })}
        </div>
        <AddHarnessDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          existingIds={Object.keys(config)}
          onAdd={(id, harness) => {
            void save({ ...config, [id]: harness })
            setAddOpen(false)
          }}
        />
        {login && (
          <AccountLoginDialog
            key={login.start.loginId}
            accountName={login.name}
            start={{
              terminalId: login.start.loginId,
              state: login.start.state,
            }}
            open
            onOpenChange={(open) => {
              if (!open) setLogin(null)
            }}
            onOpenChangeComplete={(open) => {
              if (!open) {
                setLogin(null)
                void refresh()
              }
            }}
          />
        )}
        {loginOptions && (
          <LoginOptionsDialog
            options={loginOptions}
            onOpenChange={(open) => {
              if (!open) setLoginOptions(null)
            }}
            onSubmit={(provider, method) => {
              const selected = loginOptions
              setLoginOptions(null)
              void startLogin(
                selected.id,
                selected.name,
                provider || undefined,
                method || undefined,
              )
            }}
          />
        )}
        {signOut && (
          <AccountSignOutDialog
            displayName={signOut.name}
            accountId={signOut.id}
            harnessKind={signOut.kind}
            homePath={signOut.home}
            accountsDir={accountsDir}
            open
            onOpenChange={(open) => {
              if (!open) setSignOut(null)
            }}
            onFinished={() => void refresh()}
          />
        )}
      </SettingsPage>
    </TooltipProvider>
  )
}

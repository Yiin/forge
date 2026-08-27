import { LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type * as React from 'react'
import { toast } from 'sonner'
import type { HarnessConfig } from '@forge/protocol/config'
import type { HarnessAccountSnapshot } from '@forge/protocol/accounts'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { api } from '../../lib/api'
import {
  allocateAccountHome,
  getAccountsDir,
  listHarnessStatus,
  loginStart,
} from '../../lib/accounts-api'
import {
  buildAccountReorderPatch,
  moveAccount,
  nextAccountIdentity,
  orderAccountRows,
  readAccountHome,
  withAccountHome,
  HARNESS_KINDS,
  type HarnessKind,
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
const labels: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  opencode: 'OpenCode',
}

export function HarnessSettings() {
  const [config, setConfig] = useState<Record<string, Harness>>({})
  const [snapshots, setSnapshots] = useState<HarnessAccountSnapshot[]>([])
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [addOpen, setAddOpen] = useState(false)
  const [login, setLogin] = useState<LoginTarget | null>(null)
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
      const next = await listHarnessStatus()
      setSnapshots(next)
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
    const ids = new Set([
      kind,
      ...snapshots
        .filter((item) => item.harnessKind === kind)
        .map((item) => item.accountId),
      ...Object.keys(config).filter(
        (id) =>
          id !== kind &&
          (snapshotFor(id)?.harnessKind === kind || id.startsWith(`${kind}_`)),
      ),
    ])
    return orderAccountRows(
      [...ids]
        .map((id) => ({
          accountId: id,
          harness: config[id] ?? config[kind],
          availability: (snapshotFor(id)?.availability ?? 'available') as
            'available' | 'unavailable',
        }))
        .filter(
          (
            row,
          ): row is {
            accountId: string
            harness: Harness
            availability: 'available' | 'unavailable'
          } => Boolean(row.harness),
        ),
      Object.keys(config),
    )
  }
  const addManagedAccount = async (kind: HarnessKind) => {
    if (isAdding) return
    setBusyState((current) => new Set(current).add(`add:${kind}`))
    const identity = nextAccountIdentity(
      kind,
      new Set([
        ...Object.keys(config),
        ...snapshots.map((item) => item.accountId),
      ]),
    )
    const name = `${labels[kind]} ${identity.displayName}`
    try {
      const base = config[kind]
      if (!base) throw new Error('This harness has no managed credential home.')
      const allocated = await allocateAccountHome({
        harnessKind: kind,
        accountId: identity.accountId,
      })
      const current = (await api.listHarnesses()) as Record<string, Harness>
      if (current[identity.accountId])
        throw new Error('Another account used this ID. Try Add account again.')
      const next = {
        ...current,
        [identity.accountId]: withAccountHome(
          { ...base, name, harnessKind: kind },
          allocated.homePath,
        ) as Harness,
      }
      if (!(await save(next, `Could not save ${name}`))) return
      try {
        setLogin({
          id: identity.accountId,
          name,
          start: await loginStart({ accountId: identity.accountId }),
        })
      } catch {
        toast.error(`${name} was added, but sign-in did not start`, {
          description: 'Open the account card and try Sign in again.',
        })
      }
      await refresh()
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      toast.error(`Could not add ${name}`, {
        description: detail.includes('managed credential')
          ? detail
          : 'The server could not allocate an account home.',
      })
    } finally {
      setBusyState((current) => {
        const next = new Set(current)
        next.delete(`add:${kind}`)
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
    const previous = config
    const patch = buildAccountReorderPatch({
      config: { harness: config },
      groupOrder: moved,
    })
    setConfig(patch.harness)
    if (!(await save(patch.harness))) setConfig(previous)
  }
  const signIn = async (id: string, name: string) => {
    setBusyState((current) => new Set(current).add(`sign-in:${id}`))
    try {
      setLogin({ id, name, start: await loginStart({ accountId: id }) })
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
  const checked = checkedAt
    ? Number.isNaN(Date.parse(checkedAt))
      ? 'unavailable'
      : `${Math.max(0, Math.floor((Date.now() - Date.parse(checkedAt)) / 1000))}s ago`
    : null
  const kinds = [
    ...new Set([
      ...HARNESS_KINDS.filter((kind) => config[kind]),
      ...Object.keys(config).map((id) => id.split('_account_')[0]),
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
                  title={labels[kind] ?? kind}
                  headerAction={
                    HARNESS_KINDS.includes(kind as HarnessKind) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isAdding}
                        onClick={() =>
                          void addManagedAccount(kind as HarnessKind)
                        }
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
                  {rows.map((row, index) => {
                    const name =
                      row.harness.name ||
                      snapshotFor(row.accountId)?.displayName ||
                      row.accountId
                    return (
                      <HarnessAccountCard
                        key={row.accountId}
                        accountId={row.accountId}
                        harness={row.harness}
                        snapshot={snapshotFor(row.accountId)}
                        isExpanded={expanded[row.accountId] ?? false}
                        onExpandedChange={(open) =>
                          setExpanded((current) => ({
                            ...current,
                            [row.accountId]: open,
                          }))
                        }
                        onUpdate={(next) => {
                          const all = { ...config, [row.accountId]: next }
                          void save(all)
                        }}
                        onDelete={
                          row.accountId === kind
                            ? undefined
                            : async () => {
                                const next = { ...config }
                                delete next[row.accountId]
                                await save(next)
                              }
                        }
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
                            kind,
                            home: readAccountHome({
                              harnessKind: kind,
                              env: row.harness.env,
                            }),
                          })
                        }
                        reorder={
                          rows.length > 1
                            ? {
                                onMoveUp:
                                  index > 0
                                    ? () =>
                                        void reorder(rows, row.accountId, 'up')
                                    : undefined,
                                onMoveDown:
                                  index < rows.length - 1
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
                  })}
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

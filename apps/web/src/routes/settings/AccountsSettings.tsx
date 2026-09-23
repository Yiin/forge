import { CirclePlus, LoaderCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { HarnessConfig } from '@forge/protocol/config'
import type { HarnessAccountConfig } from '@forge/protocol/accounts'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { api } from '../../lib/api'
import {
  clearCooldown,
  createAccount,
  deleteAccount,
  getAccountsDir,
  listAccounts,
  listHarnessHealth,
  listHarnessStatus,
  loginStart,
  refreshUsage,
  reorderAccounts,
  updateAccount,
  type Account,
  type HarnessAccountSnapshot,
  type HarnessHealthSummary,
} from '../../lib/accounts-api'
import { isManagedAccountHome } from '../../lib/harness-accounts-logic'
import {
  AccountLoginDialog,
  type AccountLoginStart,
} from '../../components/settings/AccountLoginDialog'
import { AccountDeleteDialog } from '../../components/settings/AccountDeleteDialog'
import { AccountModelDialog } from '../../components/settings/AccountModelDialog'
import { AccountRenameDialog } from '../../components/settings/AccountRenameDialog'
import {
  AccountRow,
  type AccountRowAction,
} from '../../components/settings/AccountRow'
import { AccountSignOutDialog } from '../../components/settings/AccountSignOutDialog'
import { HarnessMark } from '../../components/settings/HarnessMark'
import { LoginOptionsDialog } from '../../components/settings/LoginOptionsDialog'
import {
  buildAccountSections,
  needsLoginOptions,
  newAccountLabel,
  orderWithFirst,
  orderWithMove,
  type AccountRowModel,
  type AccountSectionModel,
} from '../../components/settings/accounts-settings-logic'
import {
  SettingsCard,
  SettingsPage,
  SettingsStrip,
  useRelativeTimeTick,
} from '../../components/settings/settings-layout'

type PageData = {
  config: Record<string, HarnessConfig>
  health: HarnessHealthSummary[]
  accounts: Account[]
  snapshots: HarnessAccountSnapshot[]
  accountsDir: string | null
}

/** A sign-in in progress. `isNew` accounts are deleted if it never succeeds. */
type LoginFlow = {
  accountId: string
  title: string
  description: string
  isNew: boolean
}

type DialogState =
  | ({ type: 'options'; provider: string } & LoginFlow)
  | ({ type: 'login'; start: AccountLoginStart } & LoginFlow)
  | { type: 'rename' | 'model' | 'delete' | 'sign-out'; row: AccountRowModel }
  | null

const ADD_DESCRIPTION =
  'Sign in to the account you want to add. Your current accounts are untouched.'

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

async function fetchPageData(): Promise<PageData> {
  const [config, health, accounts, snapshots, accountsDir] = await Promise.all([
    api.listHarnesses() as Promise<Record<string, HarnessConfig>>,
    listHarnessHealth(),
    listAccounts(),
    listHarnessStatus(),
    getAccountsDir().catch(() => null),
  ])
  return { config, health, accounts, snapshots, accountsDir }
}

function SkeletonRow({ dim }: { dim?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-stretch gap-3 border-t px-5 py-3.5 first:border-t-0',
        dim && 'opacity-60',
      )}
    >
      <Skeleton className="size-8 shrink-0 self-center rounded-full" />
      <div className="min-w-0 flex-1">
        <Skeleton className="h-3.5 w-44 max-w-[60%] rounded" />
        <div className="mt-2 flex flex-col gap-2">
          {[0, 1].map((index) => (
            <div key={index} className="flex items-center gap-2">
              <Skeleton className="h-2.5 w-12 rounded" />
              <Skeleton className="h-[5px] max-w-[230px] min-w-14 flex-1 rounded-full" />
              <Skeleton className="h-2.5 w-16 rounded" />
            </div>
          ))}
        </div>
      </div>
      <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
    </div>
  )
}

function LoadingSection() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading accounts…</span>
      <div className="flex h-8 items-center gap-2">
        <Skeleton className="size-6 rounded-md" />
        <Skeleton className="h-3.5 w-20 rounded" />
      </div>
      <SettingsCard className="mt-2">
        <SkeletonRow />
        <SkeletonRow dim />
      </SettingsCard>
    </div>
  )
}

export function AccountsSettings() {
  const nowMs = useRelativeTimeTick(30_000)
  const [data, setData] = useState<PageData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, AccountRowAction>>({})
  const [adding, setAdding] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState>(null)
  const loadSeq = useRef(0)

  /** Reloads everything; `quiet` loads keep old data on failure. */
  const load = useCallback(async (quiet = false) => {
    const seq = ++loadSeq.current
    try {
      const next = await fetchPageData()
      if (seq !== loadSeq.current) return
      setData(next)
      setLoadError(null)
    } catch (cause) {
      if (seq === loadSeq.current && !quiet) setLoadError(errorText(cause))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(true), 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  const sections = data
    ? buildAccountSections({ ...data, nowMs })
    : ([] as AccountSectionModel[])

  const refresh = async () => {
    setRefreshing(true)
    const signedIn = sections.flatMap((section) =>
      section.rows.filter((row) => row.signedIn),
    )
    await Promise.allSettled(signedIn.map((row) => refreshUsage(row.id)))
    setLoadError(null)
    await load()
    setRefreshing(false)
  }

  /** Runs one row action with the row marked busy and errors in the strip. */
  const run = async (
    row: AccountRowModel,
    action: AccountRowAction,
    failure: string,
    task: () => Promise<unknown>,
  ) => {
    setBusy((current) => ({ ...current, [row.id]: action }))
    setActionError(null)
    try {
      await task()
      await load(true)
    } catch (cause) {
      setActionError(`${failure}: ${errorText(cause)}`)
    } finally {
      setBusy((current) => {
        const next = { ...current }
        delete next[row.id]
        return next
      })
    }
  }

  /** Saves a patch from a dialog; resolves to an error message or null. */
  const save = async (
    id: string,
    patch: { label?: string; config?: HarnessAccountConfig },
  ) => {
    try {
      await updateAccount(id, patch)
      await load(true)
      return null
    } catch (cause) {
      return errorText(cause)
    }
  }

  const discardNewAccount = async (accountId: string) => {
    try {
      await deleteAccount(accountId, true)
    } catch (cause) {
      setActionError(
        `Could not remove the unfinished account: ${errorText(cause)}`,
      )
    }
  }

  const beginLogin = async (
    flow: LoginFlow,
    options: { provider?: string; method?: string } = {},
  ) => {
    try {
      const start = await loginStart({ accountId: flow.accountId, ...options })
      if (options.provider) {
        const account = data?.accounts.find(
          (item) => item.id === flow.accountId,
        )
        await updateAccount(flow.accountId, {
          config: { ...account?.config, provider: options.provider },
        })
      }
      setDialog({
        type: 'login',
        ...flow,
        start: { terminalId: start.loginId, state: start.state },
      })
    } catch (cause) {
      setDialog(null)
      setActionError(`Could not start sign-in: ${errorText(cause)}`)
      if (flow.isNew) await discardNewAccount(flow.accountId)
      await load(true)
    }
  }

  const startLogin = async (flow: LoginFlow, kind: string, provider = '') => {
    if (needsLoginOptions(kind))
      return setDialog({ type: 'options', ...flow, provider })
    await beginLogin(flow)
  }

  const addAccount = async (section: AccountSectionModel) => {
    if (!section.accountKind || adding) return
    setAdding(section.key)
    setActionError(null)
    try {
      const account = await createAccount({
        harnessKey: section.key,
        label: newAccountLabel(section),
        kind: section.accountKind,
      })
      await startLogin(
        {
          accountId: account.id,
          title: `Add ${section.name} account`,
          description: ADD_DESCRIPTION,
          isNew: true,
        },
        section.accountKind,
      )
    } catch (cause) {
      setActionError(
        `Could not add a ${section.name} account: ${errorText(cause)}`,
      )
    } finally {
      setAdding(null)
    }
  }

  const endLogin = async (flow: LoginFlow, succeeded: boolean) => {
    setDialog(null)
    if (!succeeded && flow.isNew) await discardNewAccount(flow.accountId)
    await load(true)
  }

  const onRowAction = (
    section: AccountSectionModel,
    row: AccountRowModel,
    action: AccountRowAction,
  ) => {
    const ids = section.rows.map((item) => item.id)
    switch (action) {
      case 'switch':
        return void run(row, action, `Could not switch to ${row.label}`, () =>
          reorderAccounts(orderWithFirst(ids, row.id)),
        )
      case 'move-up':
      case 'move-down': {
        const order = orderWithMove(
          ids,
          row.id,
          action === 'move-up' ? 'up' : 'down',
        )
        if (!order) return
        return void run(row, action, 'Could not save the account order', () =>
          reorderAccounts(order),
        )
      }
      case 'toggle-enabled':
        return void run(
          row,
          action,
          `Could not ${row.disabled ? 'enable' : 'disable'} ${row.label}`,
          () => updateAccount(row.id, { disabled: !row.disabled }),
        )
      case 'clear-cooldown':
        return void run(row, action, 'Could not clear the cooldown', () =>
          clearCooldown(row.id),
        )
      case 'refresh-usage':
        return void run(row, action, 'Could not refresh usage', () =>
          refreshUsage(row.id),
        )
      case 'sign-in':
        setActionError(null)
        return void startLogin(
          {
            accountId: row.id,
            title: `Sign in to ${row.label}`,
            description:
              'Finish signing in with the provider. Only this account changes.',
            isNew: false,
          },
          row.kind,
          row.config?.provider ?? '',
        )
      case 'rename':
      case 'model':
      case 'delete':
      case 'sign-out':
        return setDialog({ type: action, row })
    }
  }

  const accountCount = data?.accounts.length

  return (
    <SettingsPage
      title="Accounts"
      count={accountCount}
      subtitle="Signed-in accounts for each agent. Every account keeps its own credentials on this server. New sessions use the active account, and Forge moves to the next account when one hits a limit."
      actions={
        <Button
          variant="ghost"
          size="sm"
          className="text-[12.5px] text-muted-foreground"
          disabled={refreshing || !data}
          onClick={() => void refresh()}
        >
          <RefreshCw
            aria-hidden
            className={cn(refreshing && 'motion-safe:animate-spin')}
          />
          Refresh
        </Button>
      }
    >
      {actionError && (
        <SettingsStrip tone="error" onDismiss={() => setActionError(null)}>
          {actionError}
        </SettingsStrip>
      )}
      {loadError && !data && (
        <SettingsStrip tone="error" onRetry={() => void load()}>
          Could not load accounts: {loadError}
        </SettingsStrip>
      )}
      {!data && !loadError && <LoadingSection />}
      {data && sections.length === 0 && (
        <SettingsCard className="px-5 py-8 text-center text-[13px] text-muted-foreground">
          No agent here supports accounts. Add Claude, Codex, or another
          account-based agent under Agents.
        </SettingsCard>
      )}
      {sections.map((section) => (
        <section key={section.key} aria-labelledby={`accounts-${section.key}`}>
          <div className="flex min-h-8 items-center gap-2">
            <span className="grid size-6 shrink-0 place-items-center text-muted-foreground">
              <HarnessMark kind={section.markKind} />
            </span>
            <h2
              id={`accounts-${section.key}`}
              className="min-w-0 truncate text-sm font-medium"
            >
              {section.name}
            </h2>
            <div className="flex-1" />
            {section.accountKind && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground"
                disabled={adding !== null}
                onClick={() => void addAccount(section)}
              >
                {adding === section.key ? (
                  <LoaderCircle
                    aria-hidden
                    className="motion-safe:animate-spin"
                  />
                ) : (
                  <CirclePlus aria-hidden />
                )}
                Add account
              </Button>
            )}
          </div>
          {!section.installed && section.command && (
            <SettingsStrip tone="warning" className="mt-2">
              The {section.command} CLI is not installed on this server.
            </SettingsStrip>
          )}
          {!section.enabled && (
            <SettingsStrip tone="warning" className="mt-2">
              {section.name} is turned off under Agents. New sessions can&apos;t
              use these accounts until you turn it on.
            </SettingsStrip>
          )}
          <SettingsCard className="mt-2">
            {section.rows.length === 0 ? (
              <p className="px-5 py-8 text-center text-[13px] text-muted-foreground">
                No {section.name} account yet. Add one to run {section.name}{' '}
                sessions.
              </p>
            ) : (
              section.rows.map((row, index) => (
                <AccountRow
                  key={row.id}
                  row={row}
                  index={index}
                  count={section.rows.length}
                  busy={busy[row.id] ?? null}
                  nowMs={nowMs}
                  onAction={(action) => onRowAction(section, row, action)}
                />
              ))
            )}
          </SettingsCard>
        </section>
      ))}
      {data && sections.length > 0 && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Switch changes which account new sessions use. Running sessions keep
          their account.
        </p>
      )}
      {dialog?.type === 'options' && (
        <LoginOptionsDialog
          title={dialog.title}
          provider={dialog.provider}
          onCancel={() => void endLogin(dialog, false)}
          onSubmit={(provider, method) =>
            void beginLogin(dialog, {
              provider: provider || undefined,
              method: method || undefined,
            })
          }
        />
      )}
      {dialog?.type === 'login' && (
        <AccountLoginDialog
          key={dialog.start.terminalId}
          title={dialog.title}
          description={dialog.description}
          start={dialog.start}
          onClose={(status) => void endLogin(dialog, status === 'succeeded')}
        />
      )}
      {dialog?.type === 'rename' && (
        <AccountRenameDialog
          label={dialog.row.label}
          onSave={(label) => save(dialog.row.id, { label })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'model' && (
        <AccountModelDialog
          accountId={dialog.row.id}
          accountName={dialog.row.label}
          kind={dialog.row.kind}
          config={dialog.row.config}
          onSave={(config) => save(dialog.row.id, { config })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'delete' && (
        <AccountDeleteDialog
          accountName={dialog.row.label}
          managedHome={isManagedAccountHome({
            homePath: dialog.row.homePath,
            accountsDir: data?.accountsDir,
            harnessKind: dialog.row.kind,
            accountId: dialog.row.id,
          })}
          onDelete={async (removeHome) => {
            try {
              await deleteAccount(dialog.row.id, removeHome)
              await load(true)
              return null
            } catch (cause) {
              return errorText(cause)
            }
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'sign-out' && (
        <AccountSignOutDialog
          displayName={dialog.row.label}
          accountId={dialog.row.id}
          harnessKind={dialog.row.kind}
          homePath={dialog.row.homePath}
          accountsDir={data?.accountsDir}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
          onFinished={() => void load(true)}
        />
      )}
    </SettingsPage>
  )
}

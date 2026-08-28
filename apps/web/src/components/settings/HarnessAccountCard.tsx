import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Cpu,
  LogIn,
  LogOut,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type { HarnessConfig } from '@forge/protocol/config'
import type { HarnessAccountSnapshot } from '@forge/protocol/accounts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  deriveAccountLimitState,
  formatResetCountdown,
  LIMIT_KIND_LABELS,
  readAccountHome,
  resolveAccountAuthAction,
} from '@/lib/harness-accounts-logic'
import { accountConfigFields } from '@/lib/account-config-fields'
import { getAccountModels, refreshUsage } from '@/lib/accounts-api'
import type { HarnessAccountConfig } from '@forge/protocol/accounts'
import { useRelativeTimeTick } from './settings-layout'
import { RedactedSensitiveText } from './RedactedSensitiveText'

type Props = {
  accountId: string
  accountKind: string
  harness: HarnessConfig
  snapshot: HarnessAccountSnapshot | undefined
  label: string
  config?: HarnessAccountConfig | null
  isExpanded: boolean
  onExpandedChange: (open: boolean) => void
  onUpdateAccount: (patch: {
    label?: string
    disabled?: boolean
    config?: HarnessAccountConfig | null
  }) => Promise<boolean>
  onDelete?: () => void
  /** Real credential home for a managed account row. Falls back to the env-derived home when omitted. */
  homePath?: string | null
  headerAction?: ReactNode
  isSettingsDisabled?: boolean
  authActionBusy?: 'sign-in' | 'sign-out' | null
  onSignIn?: () => void
  onSignOut?: () => void
  reorder?: {
    onMoveUp: (() => void) | undefined
    onMoveDown: (() => void) | undefined
  }
}

const statusDot: Record<HarnessAccountSnapshot['status'], string> = {
  ready: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-destructive',
  disabled: 'bg-amber-400',
}

export function HarnessAccountCard({
  accountId,
  accountKind,
  harness,
  snapshot,
  isExpanded,
  onExpandedChange,
  label: labelProp,
  config,
  onUpdateAccount,
  onDelete,
  homePath,
  headerAction,
  isSettingsDisabled = false,
  authActionBusy = null,
  onSignIn,
  onSignOut,
  reorder,
}: Props) {
  const tick = useRelativeTimeTick(30_000)
  const [label, setLabel] = useState(labelProp)
  const [accountConfig, setAccountConfig] = useState(config)
  const [labelState, setLabelState] = useState<'idle' | 'saving' | 'error'>(
    'idle',
  )
  const [configState, setConfigState] = useState<'idle' | 'saving' | 'error'>(
    'idle',
  )
  const [models, setModels] = useState<
    Array<{ slug: string; name: string; subProvider?: string }>
  >([])
  const [usageExpanded, setUsageExpanded] = useState(false)
  const [usageRefreshing, setUsageRefreshing] = useState(false)
  const enabled = snapshot?.status !== 'disabled'
  const kind = accountKind
  // `harness` is the shared config for the whole kind (command/args/env), so
  // every row in a group carries the same `harness.name`. A real account row
  // (accountId !== kind) must show its own label first, or every row in the
  // group would render the identical title.
  const displayName = snapshot?.displayName || label || accountId
  const authStatus = snapshot?.auth.status ?? 'unknown'
  const authAction = resolveAccountAuthAction({
    harnessKind: kind,
    authStatus,
    serverMessage: snapshot?.message,
  })
  const limit = deriveAccountLimitState({
    usage: snapshot?.usage,
    limit: snapshot?.limit
      ? { kind: snapshot.limit.kind, resetsAt: snapshot.limit.resetsAt }
      : null,
    nowMs: tick,
  })
  const authBadge =
    authStatus === 'authenticated'
      ? ['Authenticated', 'success']
      : authStatus === 'unauthenticated'
        ? ['Sign-in needed', 'warning']
        : ['Auth unknown', 'secondary']
  const home =
    homePath !== undefined
      ? homePath
      : readAccountHome({ harnessKind: kind, env: harness.env })
  const status = snapshot?.status ?? (enabled ? 'warning' : 'disabled')
  const email = snapshot?.auth.email
  const usage = snapshot?.usage
  const usageSupported = snapshot?.usageStatus !== 'unsupported'
  const hasWireUsage = usage?.some((window) => window.windowId !== undefined)
  const usageState = !snapshot
    ? 'loading'
    : !usageSupported
      ? 'unsupported'
      : snapshot.auth.status !== 'authenticated'
        ? 'auth'
        : usage?.length
          ? snapshot.usageStatus === 'unavailable'
            ? 'unavailable'
            : 'ready'
          : 'empty'
  const usageHeadline = limit?.utilization
  useEffect(() => setLabel(labelProp), [labelProp])
  useEffect(() => setAccountConfig(config), [config])
  useEffect(() => {
    if (!['opencode', 'pi', 'grok'].includes(kind)) return
    void getAccountModels(accountId)
      .then(setModels)
      .catch(() => setModels([]))
  }, [accountId, kind])
  useEffect(() => {
    if (label === labelProp || !label.trim()) return
    setLabelState('saving')
    const timer = window.setTimeout(() => {
      void onUpdateAccount({ label })
        .then((ok) => {
          setLabelState(ok ? 'idle' : 'error')
          if (!ok) setLabel(labelProp)
        })
        .catch(() => {
          setLabelState('error')
          setLabel(labelProp)
        })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [label, labelProp, onUpdateAccount])
  const updateConfig = (key: keyof HarnessAccountConfig, value: string) => {
    const next = { ...accountConfig, [key]: value || undefined }
    setAccountConfig(next)
    setConfigState('saving')
    void onUpdateAccount({ config: next })
      .then((ok) => setConfigState(ok ? 'idle' : 'error'))
      .catch(() => setConfigState('error'))
  }
  const fields = accountConfigFields(kind)
  const iconName = `harness ${kind} account ${accountId}`

  return (
    <div
      className="border-t border-border/60 first:border-t-0"
      aria-busy={isSettingsDisabled || authActionBusy !== null || undefined}
      inert={isSettingsDisabled || authActionBusy !== null || undefined}
    >
      <div className="px-4 py-3.5 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                className="relative inline-flex size-5 shrink-0 items-center justify-center"
                aria-label={iconName}
              >
                <Cpu className="size-4 text-foreground/80" aria-hidden />
                <span
                  className={cn(
                    'absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card',
                    statusDot[status],
                  )}
                  aria-hidden
                />
              </span>
              <h3 className="truncate text-[13px] font-semibold tracking-[-0.01em]">
                {displayName}
              </h3>
              {accountId !== kind && (
                <code className="truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
                  {accountId}
                </code>
              )}
              <Badge
                variant={authBadge[1] as 'success' | 'warning' | 'secondary'}
              >
                {authBadge[0]}
              </Badge>
              {snapshot?.version && (
                <code className="text-xs text-muted-foreground">
                  {snapshot.version}
                </code>
              )}
              {snapshot?.tierLabel && (
                <Badge variant="secondary">{snapshot.tierLabel}</Badge>
              )}
              {headerAction}
              {onDelete && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="size-5 p-0 text-muted-foreground hover:text-destructive"
                      onClick={onDelete}
                      aria-label={`Delete account ${accountId}`}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete account</TooltipContent>
                </Tooltip>
              )}
            </div>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground/80">
              {authStatus === 'authenticated' && email ? (
                <>
                  Authenticated as{' '}
                  <RedactedSensitiveText
                    value={email}
                    ariaLabel={`Toggle ${accountId} email visibility`}
                    revealTooltip="Click to reveal email"
                    hideTooltip="Click to hide email"
                  />
                  {snapshot?.auth.label && <> · {snapshot.auth.label}</>}
                </>
              ) : authStatus === 'authenticated' && snapshot?.auth.label ? (
                <>
                  Authenticated as{' '}
                  <span className="font-medium text-foreground/80">
                    {snapshot.auth.label}
                  </span>
                </>
              ) : (
                <>
                  {snapshot?.message ?? 'Authentication status unavailable'}
                  {email && (
                    <>
                      {' '}
                      · Email{' '}
                      <RedactedSensitiveText
                        value={email}
                        ariaLabel={`Toggle ${accountId} email visibility`}
                        revealTooltip="Click to reveal email"
                        hideTooltip="Click to hide email"
                      />
                    </>
                  )}
                </>
              )}
            </p>
            {home && (
              <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                <span className="shrink-0">Credential home</span>
                <code className="truncate" title={home}>
                  {home}
                </code>
              </p>
            )}
            {authAction.kind === 'manual' && (
              <p className="text-xs text-muted-foreground">
                {authAction.command ? (
                  <>
                    Run{' '}
                    <code className="break-all text-foreground/80">
                      {authAction.command}
                    </code>{' '}
                    on the server to sign in.
                  </>
                ) : (
                  "Use this provider's CLI on the server to sign in."
                )}
              </p>
            )}
            {limit && (
              <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs">
                {limit.blocked && (
                  <span className="font-medium text-warning">
                    {snapshot?.limit
                      ? LIMIT_KIND_LABELS[snapshot.limit.kind]
                      : 'Usage limit reached'}
                    {limit.blocked.resetsAt &&
                      ` · resets in ${formatResetCountdown(limit.blocked.resetsAt, tick)}`}
                  </span>
                )}
                {limit.utilization && (
                  <span className="text-muted-foreground/80">
                    {limit.blocked && '· '}Usage {limit.utilization.percent}% ·{' '}
                    {limit.utilization.windowLabel}
                    {!limit.blocked &&
                      limit.utilization.resetsAt &&
                      ` · resets in ${formatResetCountdown(limit.utilization.resetsAt, tick)}`}
                  </span>
                )}
              </p>
            )}
            {usageSupported && usageState !== 'unsupported' &&
              snapshot?.auth.status !== 'unknown' && (
              <div className="mt-2 space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Usage</span>
                  {usageState === 'loading' && <span className="text-muted-foreground">Loading usage…</span>}
                  {usageState === 'auth' && <span className="text-muted-foreground">Sign in to view usage.</span>}
                  {usageState === 'empty' && <span className="text-muted-foreground">No usage data yet.</span>}
                  {usageState === 'unavailable' && <span className="text-warning">Provider unavailable. Last known windows shown.</span>}
                  {usageHeadline && hasWireUsage && (
                    <span className={cn('font-medium', usageHeadline.percent >= 90 && 'text-destructive')}>
                      {usageHeadline.windowLabel} {usageHeadline.percent}%
                    </span>
                  )}
                  <Button type="button" size="icon-xs" variant="ghost" className="ml-auto" disabled={usageRefreshing} onClick={() => { setUsageRefreshing(true); void refreshUsage(accountId).finally(() => setUsageRefreshing(false)) }} aria-label="Refresh usage">
                    <RefreshCw className={cn('size-3.5', usageRefreshing && 'animate-spin')} />
                  </Button>
                  {usage?.length ? <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => setUsageExpanded(!usageExpanded)}>{usageExpanded ? 'Hide windows' : 'Show windows'}</Button> : null}
                </div>
                {usageHeadline?.resetsAt && <span className="text-muted-foreground">Resets in {formatResetCountdown(usageHeadline.resetsAt, tick)}</span>}
                {usageExpanded && usage?.map((window) => {
                  const percent = Math.round(window.utilization <= 1 ? window.utilization * 100 : window.utilization)
                  return <div key={window.windowId} className="space-y-1 rounded-md border border-border/60 p-2">
                    <div className="flex justify-between"><span>{window.window}</span><span className={cn(percent >= 90 && 'font-semibold text-destructive')}>{percent}%{window.resetsAt ? ` · resets in ${formatResetCountdown(window.resetsAt, tick) ?? 'now'}` : ''}</span></div>
                    <Progress value={percent} className={percent >= 90 ? '[&>div]:bg-destructive' : undefined} />
                  </div>
                })}
              </div>
            )}
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {authAction.kind === 'sign-in' && onSignIn && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 min-h-7 px-2 text-xs"
                onClick={onSignIn}
                disabled={isSettingsDisabled || authActionBusy === 'sign-in'}
              >
                <LogIn className="size-3.5" />
                {authActionBusy === 'sign-in' ? 'Signing in' : 'Sign in'}
              </Button>
            )}
            {authAction.kind === 'sign-out' && onSignOut && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 min-h-7 px-2 text-xs"
                onClick={onSignOut}
                disabled={isSettingsDisabled || authActionBusy === 'sign-out'}
              >
                <LogOut className="size-3.5" />
                {authActionBusy === 'sign-out' ? 'Signing out' : 'Sign out'}
              </Button>
            )}
            {reorder && (
              <div className="flex items-center">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-1.5"
                  disabled={!reorder.onMoveUp}
                  onClick={reorder.onMoveUp}
                  aria-label={`Move ${displayName} up in rotation order`}
                >
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-1.5"
                  disabled={!reorder.onMoveDown}
                  onClick={reorder.onMoveDown}
                  aria-label={`Move ${displayName} down in rotation order`}
                >
                  <ArrowDown className="size-3.5" />
                </Button>
              </div>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => onExpandedChange(!isExpanded)}
              aria-label={`Toggle ${displayName} details`}
            >
              <ChevronDown
                className={cn(
                  'size-3.5 transition-transform',
                  isExpanded && 'rotate-180',
                )}
              />
            </Button>
            <Switch
              checked={enabled}
              disabled={isSettingsDisabled}
              onCheckedChange={(checked) => {
                void onUpdateAccount({ disabled: !checked })
              }}
              aria-label={`Enable ${displayName}`}
            />
          </div>
        </div>
      </div>
      <Collapsible open={isExpanded} onOpenChange={onExpandedChange}>
        <CollapsibleContent>
          <div className="space-y-3 border-t border-border/60 px-4 py-3 sm:px-5">
            <label className="grid gap-1 text-xs font-medium">
              Label
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                aria-invalid={labelState === 'error' || undefined}
              />
              {labelState === 'saving' && (
                <span className="text-muted-foreground">Saving…</span>
              )}
              {labelState === 'error' && (
                <span className="text-destructive">Could not save label.</span>
              )}
            </label>
            <p className="text-xs text-muted-foreground">
              Credential home <code>{home ?? 'Not captured'}</code>
            </p>
            <p className="text-xs text-muted-foreground">
              Email: {email ?? 'Not captured'} · Plan:{' '}
              {snapshot?.auth.plan ?? 'Not captured'}
            </p>
            {fields.map((field) => (
              <label className="grid gap-1 text-xs font-medium" key={field.key}>
                {field.label}
                {field.key === 'model' && models.length > 0 ? (
                  <Select
                    value={String(accountConfig?.model ?? '')}
                    onValueChange={(value) => updateConfig('model', value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select model" />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((model) => (
                        <SelectItem key={model.slug} value={model.slug}>
                          {model.subProvider ? `${model.subProvider} · ` : ''}
                          {model.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : field.control === 'select' ? (
                  <Select
                    value={String(accountConfig?.[field.key] ?? '')}
                    onValueChange={(value) => updateConfig(field.key, value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select level" />
                    </SelectTrigger>
                    <SelectContent>
                      {field.options?.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={String(accountConfig?.[field.key] ?? '')}
                    placeholder={field.placeholder}
                    onChange={(event) =>
                      updateConfig(field.key, event.target.value)
                    }
                  />
                )}
              </label>
            ))}
            {configState === 'saving' && (
              <span className="text-xs text-muted-foreground">
                Saving account settings…
              </span>
            )}
            {configState === 'error' && (
              <span className="text-xs text-destructive">
                Could not save account settings.
              </span>
            )}
            <p className="text-xs text-muted-foreground">
              Harness:{' '}
              <code>
                {harness.command} {harness.args.join(' ')}
              </code>{' '}
              · {harness.protocol.toUpperCase()} · group-level settings
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

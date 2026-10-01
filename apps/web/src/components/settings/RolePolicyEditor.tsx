import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import type { Hop, RolePolicy } from '@forge/protocol/rolePolicy'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  SettingsRow,
  SettingsSection,
} from '../../routes/settings-pages-implementation'
import {
  addTierHop,
  assignRoleTier,
  buildEpicRoleRows,
  createTier,
  deleteTier,
  isRolePolicyDirty,
  moveTierHop,
  removeTierHop,
  renameTier,
  setTierHopAccount,
  setTierHopHarness,
  setTierHopModel,
} from '../../routes/epic-settings-logic'
import { useAccountModels, type Providers } from './use-providers'

const UNASSIGNED = '__unassigned__'
/** Select values cannot be empty, so "no choice" gets a named value. */
const AUTO = '__auto__'
type DeleteTarget =
  | { kind: 'tier'; tierId: string }
  | { kind: 'hop'; tierId: string; index: number }

export function RolePolicyEditor({
  policy,
  providers,
  errors,
  onChange,
  onReset,
}: {
  policy: RolePolicy
  providers: Providers
  errors: Record<string, string>
  onChange: (next: RolePolicy) => void
  onReset?: () => void
}) {
  const [newTier, setNewTier] = useState('')
  const [newTierError, setNewTierError] = useState<string | null>(null)
  const [rename, setRename] = useState<Record<string, string>>({})
  const [renameErrors, setRenameErrors] = useState<Record<string, string>>({})
  const [target, setTarget] = useState<DeleteTarget | null>(null)
  const [open, setOpen] = useState(false)
  const harnessKeys = providers.harnesses.map((harness) => harness.key)
  const rows = buildEpicRoleRows(policy, harnessKeys)
  const tierIds = Object.keys(policy.tiers)
  const create = () => {
    const result = createTier(policy, newTier)
    if ('error' in result) setNewTierError(result.error)
    else {
      onChange(result.policy)
      setNewTier('')
      setNewTierError(null)
    }
  }
  const remove = () => {
    if (!target) return
    onChange(
      target.kind === 'tier'
        ? deleteTier(policy, target.tierId)
        : removeTierHop(policy, target.tierId, target.index),
    )
    setOpen(false)
    setTarget(null)
  }
  return (
    <>
      <SettingsSection
        title="Roles"
        headerAction={
          onReset && isRolePolicyDirty(policy) ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Reset roles and tiers to default"
              title="Reset roles and tiers to defaults"
              onClick={onReset}
            >
              Reset
            </Button>
          ) : null
        }
      >
        {rows.map((row) => (
          <SettingsRow
            key={row.roleId}
            label={row.label}
            description={row.description}
            status={
              row.tierId
                ? `${row.hopCount} ${row.hopCount === 1 ? 'hop' : 'hops'}${row.missingHarnesses ? `, ${row.missingHarnesses} missing harness${row.missingHarnesses === 1 ? '' : 'es'}` : ''}`
                : "Uses the run's pinned or default harness."
            }
          >
            <Select
              value={row.tierId ?? UNASSIGNED}
              onValueChange={(value) =>
                onChange(
                  assignRoleTier(
                    policy,
                    row.roleId,
                    value === UNASSIGNED ? null : value,
                  ),
                )
              }
            >
              <SelectTrigger
                className="w-full sm:w-48"
                aria-label={`Tier for ${row.label}`}
              >
                <SelectValue>{row.tierId ?? 'Unassigned'}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                {tierIds.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        ))}
      </SettingsSection>
      <SettingsSection title="Tiers">
        <SettingsRow
          label="Add tier"
          description="Create a named fallback chain for one or more epic roles."
        >
          <div className="flex w-full flex-col gap-2 sm:flex-row">
            <Input
              aria-label="New tier name"
              placeholder="high-capability"
              value={newTier}
              onChange={(e) => {
                setNewTier(e.target.value)
                setNewTierError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  create()
                }
              }}
            />{' '}
            <Button type="button" variant="outline" onClick={create}>
              <Plus />
              Add tier
            </Button>
          </div>
          {newTierError && (
            <p className="text-sm text-destructive" role="alert">
              {newTierError}
            </p>
          )}
        </SettingsRow>
        {!tierIds.length && (
          <SettingsRow
            label="No tiers configured"
            description="Add a tier, then assign it to an epic role."
          >
            <span />
          </SettingsRow>
        )}
        {tierIds.map((tierId) => (
          <TierEditor
            key={tierId}
            tierId={tierId}
            hops={policy.tiers[tierId]!}
            providers={providers}
            errors={errors}
            rename={rename[tierId] ?? tierId}
            setRename={(value) =>
              setRename((current) => ({ ...current, [tierId]: value }))
            }
            renameError={renameErrors[tierId]}
            onRename={() => {
              const result = renameTier(
                policy,
                tierId,
                rename[tierId] ?? tierId,
              )
              if ('error' in result)
                setRenameErrors((current) => ({
                  ...current,
                  [tierId]: result.error,
                }))
              else {
                onChange(result.policy)
                setRenameErrors((current) => {
                  const next = { ...current }
                  delete next[tierId]
                  return next
                })
              }
            }}
            onChange={onChange}
            policy={policy}
            onDelete={(kind, index) => {
              if (kind === 'hop' && index === undefined) return
              setTarget(
                kind === 'tier'
                  ? { kind, tierId }
                  : { kind, tierId, index: index! },
              )
              setOpen(true)
            }}
          />
        ))}
      </SettingsSection>
      <AlertDialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value)
          if (!value) setTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {target?.kind === 'tier'
                ? `Delete tier "${target.tierId}"?`
                : `Delete hop ${(target?.index ?? 0) + 1}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {target?.kind === 'tier'
                ? 'This also removes the tier from every assigned epic role.'
                : 'The remaining hops keep their current fallback order.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>
              {target?.kind === 'tier' ? 'Delete tier' : 'Delete hop'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function TierEditor({
  tierId,
  hops,
  providers,
  errors,
  rename,
  setRename,
  renameError,
  onRename,
  onChange,
  policy,
  onDelete,
}: {
  tierId: string
  hops: Hop[]
  providers: Providers
  errors: Record<string, string>
  rename: string
  setRename: (value: string) => void
  renameError?: string
  onRename: () => void
  onChange: (next: RolePolicy) => void
  policy: RolePolicy
  onDelete: (kind: 'tier' | 'hop', index?: number) => void
}) {
  const defaultHarness = providers.harnesses.find(
    (harness) => harness.enabled,
  )?.key
  const [hopKeys, setHopKeys] = useState(() =>
    hops.map(() => crypto.randomUUID()),
  )
  useEffect(() => {
    setHopKeys((current) =>
      current.length === hops.length
        ? current
        : hops.length > current.length
          ? [
              ...current,
              ...hops.slice(current.length).map(() => crypto.randomUUID()),
            ]
          : current.slice(0, hops.length),
    )
  }, [hops.length])
  const move = (index: number, direction: 'up' | 'down') => {
    const target = index + (direction === 'up' ? -1 : 1)
    setHopKeys((current) => {
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target]!, next[index]!]
      return next
    })
    onChange(moveTierHop(policy, tierId, index, direction))
  }
  const tierError = errors[`rolePolicy.tiers.${tierId}`]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{tierId}</p>
          <p className="text-sm text-muted-foreground">
            {hops.length
              ? `${hops.length} ${hops.length === 1 ? 'hop' : 'hops'} in fallback order.`
              : 'No hops yet. Add one to start the fallback chain.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-full sm:w-44"
            aria-label={`Rename tier ${tierId}`}
            value={rename}
            onChange={(e) => setRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onRename()
              }
            }}
          />
          <Button type="button" variant="outline" size="sm" onClick={onRename}>
            Rename
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Delete tier ${tierId}`}
            title="Delete tier"
            onClick={() => onDelete('tier')}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      {[renameError, tierError].filter(Boolean).map((message) => (
        <p key={message} className="text-sm text-destructive" role="alert">
          {message}
        </p>
      ))}
      {hops.map((hop, index) => (
        <HopEditor
          key={hopKeys[index]}
          tierId={tierId}
          index={index}
          hop={hop}
          last={index === hops.length - 1}
          providers={providers}
          errors={errors}
          onChange={(next) => onChange(next(policy))}
          onMove={(direction) => move(index, direction)}
          onDelete={() => onDelete('hop', index)}
        />
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!defaultHarness}
        onClick={() =>
          onChange(addTierHop(policy, tierId, { harness: defaultHarness! }))
        }
      >
        <Plus />
        Add hop
      </Button>
    </div>
  )
}

function HopEditor({
  tierId,
  index,
  hop,
  last,
  providers,
  errors,
  onChange,
  onMove,
  onDelete,
}: {
  tierId: string
  index: number
  hop: Hop
  last: boolean
  providers: Providers
  errors: Record<string, string>
  onChange: (update: (policy: RolePolicy) => RolePolicy) => void
  onMove: (direction: 'up' | 'down') => void
  onDelete: () => void
}) {
  const { models, request } = useAccountModels()
  const name = `${tierId} hop ${index + 1}`
  const harness = providers.harnesses.find((entry) => entry.key === hop.harness)
  const accounts = providers.accounts.filter(
    (account) => account.harnessKey === hop.harness,
  )
  // The model list comes from the pinned account, or the first account the
  // runner would try.
  const modelAccount =
    hop.accountId ?? accounts.find((account) => account.enabled)?.id
  useEffect(() => request(modelAccount), [modelAccount, request])
  const modelList = (modelAccount && models[modelAccount]) || []

  const harnessItems = [
    ...providers.harnesses
      .filter((entry) => entry.enabled || entry.key === hop.harness)
      .map((entry) => ({ value: entry.key, label: entry.name })),
    ...(harness
      ? []
      : [{ value: hop.harness, label: `Missing: ${hop.harness}` }]),
  ]
  const accountItems = [
    {
      value: AUTO,
      label: accounts.length ? 'Any account' : 'No accounts',
    },
    ...accounts.map((account) => ({
      value: account.id,
      label: account.label || account.email || account.id,
    })),
    ...(hop.accountId && !accounts.some((a) => a.id === hop.accountId)
      ? [{ value: hop.accountId, label: `Missing: ${hop.accountId}` }]
      : []),
  ]
  const modelItems = [
    { value: AUTO, label: 'Harness default' },
    ...modelList.map((model) => ({
      value: model.id,
      label: model.displayName,
    })),
    ...(hop.model && !modelList.some((model) => model.id === hop.model)
      ? [{ value: hop.model, label: hop.model }]
      : []),
  ]
  const harnessError = errors[`rolePolicy.tiers.${tierId}.${index}.harness`]
  const accountError = errors[`rolePolicy.tiers.${tierId}.${index}.accountId`]

  return (
    <div className="rounded-xl border p-3">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">Hop {index + 1}</Badge>
        <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-3">
          <HopSelect
            label={`${name} harness`}
            value={hop.harness}
            items={harnessItems}
            onChange={(value) =>
              onChange((policy) =>
                setTierHopHarness(policy, tierId, index, value),
              )
            }
          />
          <HopSelect
            label={`${name} account`}
            value={hop.accountId ?? AUTO}
            items={accountItems}
            disabled={!accounts.length && !hop.accountId}
            onChange={(value) =>
              onChange((policy) =>
                setTierHopAccount(
                  policy,
                  tierId,
                  index,
                  value === AUTO ? undefined : value,
                ),
              )
            }
          />
          <HopSelect
            label={`${name} model`}
            value={hop.model ?? AUTO}
            items={modelItems}
            onChange={(value) =>
              onChange((policy) =>
                setTierHopModel(
                  policy,
                  tierId,
                  index,
                  value === AUTO ? '' : value,
                ),
              )
            }
          />
        </div>
        <div className="flex">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Move ${name} up`}
            disabled={!index}
            onClick={() => onMove('up')}
          >
            <ArrowUp />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Move ${name} down`}
            disabled={last}
            onClick={() => onMove('down')}
          >
            <ArrowDown />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${name}`}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      {[harnessError, accountError].filter(Boolean).map((message) => (
        <p key={message} className="mt-2 text-sm text-destructive" role="alert">
          {message}
        </p>
      ))}
    </div>
  )
}

function HopSelect({
  label,
  value,
  items,
  disabled,
  onChange,
}: {
  label: string
  value: string
  items: Array<{ value: string; label: string }>
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <Select
      value={value}
      items={items}
      disabled={disabled}
      onValueChange={(next) => {
        if (next) onChange(next)
      }}
    >
      <SelectTrigger className="w-full min-w-0" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

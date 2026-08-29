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
  setTierHopHarness,
  setTierHopModel,
  setTierHopSkipAboveUtilization,
} from '../../routes/epic-settings-logic'

const UNASSIGNED = '__unassigned__'
type DeleteTarget =
  | { kind: 'tier'; tierId: string }
  | { kind: 'hop'; tierId: string; index: number }

export function RolePolicyEditor({
  policy,
  harnessKeys,
  errors,
  onChange,
  onReset,
}: {
  policy: RolePolicy
  harnessKeys: string[]
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
                ? `${row.hopCount} ${row.hopCount === 1 ? 'hop' : 'hops'}${row.missingHarnesses ? ` plus, ${row.missingHarnesses} missing harness${row.missingHarnesses === 1 ? '' : 'es'}` : ''}`
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
            harnessKeys={harnessKeys}
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
  harnessKeys,
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
  harnessKeys: string[]
  errors: Record<string, string>
  rename: string
  setRename: (value: string) => void
  renameError?: string
  onRename: () => void
  onChange: (next: RolePolicy) => void
  policy: RolePolicy
  onDelete: (kind: 'tier' | 'hop', index?: number) => void
}) {
  const defaultHarness = harnessKeys[0]
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
  return (
    <SettingsRow
      label={tierId}
      description={`${hops.length} ${hops.length === 1 ? 'hop' : 'hops'} in fallback order.`}
    >
      <div className="w-full space-y-3">
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="float-right"
          aria-label={`Delete tier ${tierId}`}
          onClick={() => onDelete('tier')}
        >
          <Trash2 />
          Delete
        </Button>
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label={`Rename tier ${tierId}`}
            value={rename}
            onChange={(e) => setRename(e.target.value)}
          />
          <Button type="button" variant="outline" size="sm" onClick={onRename}>
            Rename
          </Button>
        </div>
        {renameError && (
          <p className="text-sm text-destructive" role="alert">
            {renameError}
          </p>
        )}
        {!hops.length && (
          <div className="rounded-xl border p-3 text-sm text-muted-foreground">
            This tier has no hops. Add one to start its fallback chain.
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-3"
              disabled={!defaultHarness}
              onClick={() =>
                onChange(
                  addTierHop(policy, tierId, { harness: defaultHarness! }),
                )
              }
            >
              Add hop
            </Button>
          </div>
        )}
        {hops.map((hop, index) => (
          <div key={hopKeys[index]} className="rounded-xl border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Hop {index + 1}</Badge>
              {!harnessKeys.includes(hop.harness) && (
                <Badge
                  variant="destructive"
                  title={`Harness missing: ${hop.harness}`}
                >
                  Harness missing: {hop.harness}
                </Badge>
              )}
              <Select
                value={hop.harness}
                onValueChange={(value) =>
                  onChange(
                    setTierHopHarness(policy, tierId, index, value ?? ''),
                  )
                }
              >
                <SelectTrigger
                  className="w-full sm:w-48"
                  aria-label={`${tierId} hop ${index + 1} harness`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {harnessKeys.map((key) => (
                    <SelectItem key={key} value={key}>
                      {key}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                className="w-full sm:w-48"
                aria-label={`${tierId} hop ${index + 1} model`}
                placeholder="Model (optional)"
                value={hop.model ?? ''}
                onChange={(e) =>
                  onChange(
                    setTierHopModel(policy, tierId, index, e.target.value),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Move ${tierId} hop ${index + 1} up`}
                disabled={!index}
                onClick={() => move(index, 'up')}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Move ${tierId} hop ${index + 1} down`}
                disabled={index === hops.length - 1}
                onClick={() => move(index, 'down')}
              >
                <ArrowDown />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove ${tierId} hop ${index + 1}`}
                onClick={() => onDelete('hop', index)}
              >
                <Trash2 />
              </Button>
            </div>
            <div className="mt-3 flex items-center gap-2 text-sm">
              <label htmlFor={`${tierId}-skip-${index}`}>
                Skip above utilization
              </label>
              <Input
                id={`${tierId}-skip-${index}`}
                className="w-24"
                type="number"
                min="0"
                max="100"
                step="1"
                placeholder="None"
                aria-label={`Skip hop ${index + 1} above utilization percent`}
                value={hop.skipAboveUtilization ?? ''}
                onChange={(e) => {
                  const value =
                    e.target.value === '' ? undefined : Number(e.target.value)
                  onChange(
                    setTierHopSkipAboveUtilization(
                      policy,
                      tierId,
                      index,
                      value,
                    ),
                  )
                }}
              />
              <span>%</span>
            </div>
            {errors[`rolePolicy.tiers.${tierId}.${index}.harness`] && (
              <p className="text-sm text-destructive" role="alert">
                {errors[`rolePolicy.tiers.${tierId}.${index}.harness`]}
              </p>
            )}
          </div>
        ))}
        {hops.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!defaultHarness}
            onClick={() =>
              onChange(addTierHop(policy, tierId, { harness: defaultHarness! }))
            }
          >
            Add hop
          </Button>
        )}
      </div>
    </SettingsRow>
  )
}

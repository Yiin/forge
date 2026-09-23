import { LoaderCircle } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { HarnessAccountConfig } from '@forge/protocol/accounts'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  accountConfigFields,
  type AccountConfigField,
} from '@/lib/account-config-fields'
import { getAccountModels } from '@/lib/accounts-api'

type Values = Partial<Record<keyof HarnessAccountConfig, string>>

/** Kinds whose server can list models for the model picker. */
const MODEL_CATALOG_KINDS = new Set(['opencode', 'pi', 'grok'])

function FieldControl({
  id,
  field,
  value,
  models,
  onChange,
}: {
  id: string
  field: AccountConfigField
  value: string
  models: Array<{ id: string; name: string }>
  onChange: (value: string) => void
}) {
  const options =
    field.key === 'model' && models.length > 0
      ? models.map((model) => ({ value: model.id, label: model.name }))
      : field.control === 'select'
        ? (field.options ?? []).map((option) => ({
            value: option,
            label: option,
          }))
        : null
  if (!options)
    return (
      <Input
        id={id}
        value={value}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    )
  return (
    <Select
      value={value}
      items={options}
      onValueChange={(next) => onChange(next ?? '')}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder={`Select ${field.label.toLowerCase()}`} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Edits the per-account model settings (provider, model, thinking, …). */
export function AccountModelDialog({
  accountId,
  accountName,
  kind,
  config,
  onSave,
  onClose,
}: {
  accountId: string
  accountName: string
  kind: string
  config: HarnessAccountConfig | null | undefined
  /** Resolves to an error message, or null when the settings were saved. */
  onSave: (config: HarnessAccountConfig) => Promise<string | null>
  onClose: () => void
}) {
  const idPrefix = useId()
  const fields = accountConfigFields(kind)
  const [values, setValues] = useState<Values>(() =>
    Object.fromEntries(
      fields.map((field) => [field.key, String(config?.[field.key] ?? '')]),
    ),
  )
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!MODEL_CATALOG_KINDS.has(kind)) return
    let live = true
    void getAccountModels(accountId)
      .then((catalog) => {
        if (live)
          setModels(
            catalog.models.map((model) => ({
              id: model.id,
              name: model.displayName,
            })),
          )
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [accountId, kind])

  const save = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    const next: HarnessAccountConfig = { ...config }
    for (const field of fields) {
      const value = values[field.key]?.trim()
      Object.assign(next, { [field.key]: value || undefined })
    }
    const failure = await onSave(next)
    setSaving(false)
    if (failure) setError(failure)
    else onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent className="max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-[15px] font-semibold tracking-tight">
              Model settings
            </DialogTitle>
            <DialogDescription className="text-[13px] leading-relaxed">
              New sessions on {accountName} start with these settings. Leave a
              field empty to use the agent&apos;s default.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-4">
            {fields.map((field) => (
              <div className="grid gap-1.5" key={field.key}>
                <Label htmlFor={`${idPrefix}-${field.key}`}>
                  {field.label}
                </Label>
                <FieldControl
                  id={`${idPrefix}-${field.key}`}
                  field={field}
                  value={values[field.key] ?? ''}
                  models={models}
                  onChange={(value) =>
                    setValues((current) => ({ ...current, [field.key]: value }))
                  }
                />
              </div>
            ))}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <LoaderCircle className="motion-safe:animate-spin" />}
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

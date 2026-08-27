import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../../lib/api'
import {
  buildEpicLaunchConfig,
  type LaunchErrors,
} from '../../routes/epic-launch-logic'
import { RolePolicyEditor } from '../settings/RolePolicyEditor'
import type { RolePolicy } from '@forge/protocol/rolePolicy'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
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
import { Spinner } from '@/components/ui/spinner'

export const defaultEpicLaunchRolePolicy: RolePolicy = {
  roles: {
    'iteration-worker': 'default',
    'triage-control': 'default',
    'title-generation': 'default',
  },
  tiers: { default: [{ harness: 'claude-code-acp' }] },
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function EpicLaunchDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStarted: (runId: string) => void
}) {
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>(
    [],
  )
  const [harnesses, setHarnesses] = useState<Record<string, { name?: string }>>(
    {},
  )
  const [projectId, setProjectId] = useState('')
  const [epicBeadId, setEpicBeadId] = useState('')
  const [mode, setMode] = useState<'pool' | 'serial' | 'auto'>('pool')
  const [workerCount, setWorkerCount] = useState('3')
  const [baseBranch, setBaseBranch] = useState('main')
  const [gateCommand, setGateCommand] = useState('')
  const [installCommand, setInstallCommand] = useState('')
  const [rolePolicy, setRolePolicy] = useState(defaultEpicLaunchRolePolicy)
  const [savedRolePolicy, setSavedRolePolicy] = useState(
    defaultEpicLaunchRolePolicy,
  )
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [errors, setErrors] = useState<LaunchErrors>({})
  const [busy, setBusy] = useState(false)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  )
  const [loadError, setLoadError] = useState('')
  const loadOptions = () => {
    setLoadState('loading')
    setLoadError('')
    const settings = api.getSettings?.() ?? Promise.resolve({})
    void Promise.all([api.listProjects(), api.listHarnesses(), settings])
      .then(([projectData, harnessData, settingsData]) => {
        const nextProjects = projectData as Array<{ id: string; name: string }>
        const epicDefaults = (
          settingsData as {
            epicDefaults?: {
              rolePolicy?: RolePolicy
              gateCommand?: string | string[]
              installCommand?: string | string[]
            }
          }
        ).epicDefaults
        const saved = epicDefaults?.rolePolicy ?? defaultEpicLaunchRolePolicy
        setProjects(nextProjects)
        setProjectId((current) => current || nextProjects[0]?.id || '')
        setHarnesses(harnessData as Record<string, { name?: string }>)
        setRolePolicy(saved)
        setSavedRolePolicy(saved)
        setGateCommand(
          typeof epicDefaults?.gateCommand === 'string'
            ? epicDefaults.gateCommand
            : (epicDefaults?.gateCommand ?? []).join('\n'),
        )
        setInstallCommand(
          typeof epicDefaults?.installCommand === 'string'
            ? epicDefaults.installCommand
            : (epicDefaults?.installCommand ?? []).join('\n'),
        )
        setLoadState('ready')
      })
      .catch((cause) => {
        setLoadError(
          cause instanceof Error
            ? cause.message
            : 'Could not load launch options.',
        )
        setLoadState('error')
      })
  }
  useEffect(() => {
    if (open) loadOptions()
  }, [open])
  const fieldError = (field: string) => errors[field]
  const launch = async (event: FormEvent) => {
    event.preventDefault()
    const nextErrors: LaunchErrors = {}
    if (!projectId) nextErrors.projectId = 'Choose a project.'
    if (!epicBeadId.trim()) nextErrors.epicBeadId = 'Enter an epic id.'
    const count = Number(workerCount)
    if (!Number.isInteger(count) || count < 1 || count > 32)
      nextErrors.workerCount = 'Use a whole number from 1 to 32.'
    const parsed = buildEpicLaunchConfig(
      {
        advancedOpen,
        gateCommand,
        installCommand,
        rolePolicy,
        rolePolicyChanged: !same(rolePolicy, savedRolePolicy),
      },
      Object.keys(harnesses),
    )
    Object.assign(nextErrors, parsed.errors)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    setBusy(true)
    try {
      const result = (await api.startRun({
        projectId,
        epicBeadId: epicBeadId.trim(),
        mode,
        workerCount: count,
        baseBranch: baseBranch.trim() || 'main',
        config: parsed.value ?? {},
      })) as { id: string }
      onOpenChange(false)
      onStarted(result.id)
    } catch (cause) {
      setErrors({
        submit: cause instanceof Error ? cause.message : String(cause),
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Epic runner
          </p>
          <DialogTitle>Launch an epic</DialogTitle>
          <DialogDescription>
            Choose the project and epic. Advanced options are optional.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => void launch(event)}
        >
          {loadState === 'loading' && (
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <Spinner />
              Loading projects and harnesses…
            </div>
          )}
          {loadState === 'error' && (
            <div className="flex flex-col gap-2" role="alert">
              <p className="text-sm text-destructive">{loadError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={loadOptions}
              >
                Retry
              </Button>
            </div>
          )}
          {loadState === 'ready' && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="launch-project">Project</Label>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger
                    id="launch-project"
                    aria-invalid={Boolean(fieldError('projectId'))}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fieldError('projectId') && (
                  <p className="text-sm text-destructive">
                    {fieldError('projectId')}
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="launch-epic-id">Epic id</Label>
                <Input
                  id="launch-epic-id"
                  placeholder="forge-3b7"
                  value={epicBeadId}
                  onChange={(event) => setEpicBeadId(event.target.value)}
                  aria-invalid={Boolean(fieldError('epicBeadId'))}
                />
                {fieldError('epicBeadId') && (
                  <p className="text-sm text-destructive">
                    {fieldError('epicBeadId')}
                  </p>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="launch-mode">Mode</Label>
                  <Select
                    value={mode}
                    onValueChange={(value) => {
                      if (
                        value === 'pool' ||
                        value === 'serial' ||
                        value === 'auto'
                      )
                        setMode(value)
                    }}
                  >
                    <SelectTrigger id="launch-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pool">Pool</SelectItem>
                      <SelectItem value="serial">Serial</SelectItem>
                      <SelectItem value="auto">Auto</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="launch-workers">Workers</Label>
                  <Input
                    id="launch-workers"
                    type="number"
                    min="1"
                    max="32"
                    value={workerCount}
                    onChange={(event) => setWorkerCount(event.target.value)}
                    aria-invalid={Boolean(fieldError('workerCount'))}
                  />
                  {fieldError('workerCount') && (
                    <p className="text-sm text-destructive">
                      {fieldError('workerCount')}
                    </p>
                  )}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="launch-branch">Base branch</Label>
                  <Input
                    id="launch-branch"
                    value={baseBranch}
                    onChange={(event) => setBaseBranch(event.target.value)}
                  />
                </div>
              </div>
              <Collapsible
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
                className="rounded-lg border px-3 py-2"
              >
                <CollapsibleTrigger className="text-sm font-medium">
                  Advanced
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-3 space-y-4">
                  <div className="grid gap-2">
                    <Label htmlFor="launch-gate">Gate command</Label>
                    <Input
                      id="launch-gate"
                      value={gateCommand}
                      onChange={(event) => setGateCommand(event.target.value)}
                      placeholder="bun run test"
                      aria-invalid={Boolean(fieldError('gateCommand'))}
                    />
                    {fieldError('gateCommand') && (
                      <p className="text-sm text-destructive">
                        {fieldError('gateCommand')}
                      </p>
                    )}
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="launch-install">Install command</Label>
                    <Input
                      id="launch-install"
                      value={installCommand}
                      onChange={(event) =>
                        setInstallCommand(event.target.value)
                      }
                      placeholder="bun install"
                      aria-invalid={Boolean(fieldError('installCommand'))}
                    />
                  </div>
                  <RolePolicyEditor
                    policy={rolePolicy}
                    harnessKeys={Object.keys(harnesses)}
                    errors={errors}
                    onChange={setRolePolicy}
                    onReset={() => setRolePolicy(savedRolePolicy)}
                  />
                </CollapsibleContent>
              </Collapsible>
              {fieldError('submit') && (
                <p className="text-sm text-destructive" role="alert">
                  {fieldError('submit')}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy && <Spinner />}
                  {busy ? 'Launching…' : 'Launch epic'}
                </Button>
              </DialogFooter>
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  )
}

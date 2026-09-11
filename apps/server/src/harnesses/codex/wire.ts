import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  approvalPolicySchema,
  sandboxPolicySchema,
  type DispatchOptions,
} from '@forge/protocol/harness'

export const PROFILE = '0.153.4'
export const MiB = 1024 * 1024
export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
export function fail(code: string): never {
  throw new Error(`CODEX_${code}`)
}
export const byteSize = (value: unknown) =>
  Buffer.byteLength(
    typeof value === 'string' ? value : (JSON.stringify(value) ?? ''),
  )
export function bounded(
  value: readonly unknown[],
  count: number,
  bytes: number,
  name: string,
) {
  if (
    !Array.isArray(value) ||
    value.length > count ||
    byteSize(value) + value.length * 128 > bytes
  )
    fail(`${name}_LIMIT`)
}
export const utf8 = (max: number) =>
  z.string().refine((value) => value.length <= max && byteSize(value) <= max)
export const idSchema = utf8(1024).refine((value) => value.length > 0)
export const pathSchema = utf8(16 * 1024).refine(
  (value) => value.length > 0 && !value.includes('\0'),
)
export const cursorSchema = utf8(16 * 1024)
  .nullable()
  .optional()
export function tupleId(...parts: (string | number)[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((val, i) => same(val, b[i]))
  if (record(a) && record(b)) {
    const keys = Object.keys(a).filter((key) => a[key] !== undefined)
    return (
      keys.length ===
        Object.keys(b).filter((key) => b[key] !== undefined).length &&
      keys.every((key) => same(a[key], b[key]))
    )
  }
  return false
}
export function sameSandbox(a: unknown, b: unknown) {
  const ordered = (value: unknown) =>
    record(value) &&
    value.type === 'workspaceWrite' &&
    Array.isArray(value.writableRoots)
      ? { ...value, writableRoots: [...value.writableRoots].sort() }
      : value
  return same(ordered(a), ordered(b))
}

/** Counts retained records and encoded payloads; releases are explicit and idempotent. */
export class CodexBudget {
  private total = 0
  private readonly buckets = new Map<string, { count: number; bytes: number }>()
  constructor(private readonly maxBytes = 32 * MiB) {}
  get bytes() {
    return this.total
  }
  charge(name: string, size: number, maxCount: number, maxBytes: number) {
    let bytes = 128 + size
    const bucket = this.buckets.get(name) ?? { count: 0, bytes: 0 }
    if (
      bucket.count + 1 > maxCount ||
      bucket.bytes + bytes > maxBytes ||
      this.total + bytes > this.maxBytes
    )
      fail(`${name.toUpperCase()}_LIMIT`)
    bucket.count++
    bucket.bytes += bytes
    this.total += bytes
    this.buckets.set(name, bucket)
    let held = true
    const release = () => {
      if (!held) return
      held = false
      bucket.count--
      bucket.bytes -= bytes
      this.total -= bytes
      if (!bucket.count) this.buckets.delete(name)
    }
    return Object.assign(release, {
      resize: (size: number) => {
        if (!held) fail('BUDGET_RELEASED')
        const next = 128 + size
        const change = next - bytes
        if (
          bucket.bytes + change > maxBytes ||
          this.total + change > this.maxBytes
        )
          fail(`${name.toUpperCase()}_LIMIT`)
        bytes = next
        bucket.bytes += change
        this.total += change
      },
    })
  }
  state(name: string) {
    return this.buckets.get(name) ?? { count: 0, bytes: 0 }
  }
}

const nativeApproval = approvalPolicySchema.refine(
  (value) => value !== 'always',
)
const absolute = pathSchema.refine(isAbsolute)
export const nativeSandbox = sandboxPolicySchema.superRefine((policy, ctx) => {
  if (
    policy.type === 'workspaceWrite' &&
    policy.writableRoots?.some((path) => !absolute.safeParse(path).success)
  )
    ctx.addIssue({ code: 'custom', message: 'Invalid writable root' })
})
const nullableId = idSchema.nullish()
const anyObject = z.record(z.string(), z.unknown())
export const nativeItemSchema = z
  .object({ id: idSchema, type: idSchema })
  .catchall(z.unknown())
export type NativeItem = z.infer<typeof nativeItemSchema>
export const turnSchema = z.object({
  id: idSchema,
  items: z.array(nativeItemSchema).max(32768),
  status: z.enum(['inProgress', 'completed', 'interrupted', 'failed']),
  itemsView: z.enum(['notLoaded', 'summary', 'full']).optional(),
  error: z
    .object({
      message: z.string(),
      codexErrorInfo: z.unknown().optional(),
      additionalDetails: z.string().nullish(),
    })
    .nullish(),
  startedAt: z.number().int().nullish(),
  completedAt: z.number().int().nullish(),
  durationMs: z.number().int().nullish(),
})
export type NativeTurn = z.infer<typeof turnSchema>
export const threadSchema = z.object({
  id: idSchema,
  cwd: absolute,
  ephemeral: z.boolean(),
  sessionId: idSchema,
  cliVersion: idSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  modelProvider: idSchema,
  preview: z.string(),
  projectId: nullableId,
  source: z.union([z.string(), anyObject]),
  status: z.object({ type: idSchema }).catchall(z.unknown()),
  turns: z.array(turnSchema).max(5000),
  parentThreadId: nullableId,
  forkedFromId: nullableId,
  agentNickname: z.string().nullish(),
  agentRole: z.string().nullish(),
  historyMode: z.enum(['legacy', 'paginated']).optional(),
  path: pathSchema.nullish(),
  model: nullableId,
  reasoningEffort: nullableId,
})
export type NativeThread = z.infer<typeof threadSchema>
export const initializeSchema = z.object({
  codexHome: absolute,
  platformFamily: idSchema,
  platformOs: idSchema,
  userAgent: utf8(4096),
})
export const threadResponseSchema = z.object({
  thread: threadSchema,
  cwd: absolute,
  approvalPolicy: nativeApproval,
  approvalsReviewer: z.enum(['user', 'auto_review', 'guardian_subagent']),
  sandbox: nativeSandbox,
  model: idSchema,
  modelProvider: idSchema,
  reasoningEffort: nullableId,
  serviceTier: nullableId,
})
export type NativeThreadResponse = z.infer<typeof threadResponseSchema>
export const modelSchema = z
  .object({
    id: idSchema,
    model: idSchema,
    displayName: z.string(),
    description: z.string(),
    hidden: z.boolean(),
    isDefault: z.boolean(),
    defaultReasoningEffort: idSchema,
    supportedReasoningEfforts: z
      .array(z.object({ reasoningEffort: idSchema, description: z.string() }))
      .max(128),
    inputModalities: z.array(idSchema).max(128).optional(),
    serviceTiers: z
      .array(
        z
          .object({ id: idSchema, name: z.string(), description: z.string() })
          .catchall(z.unknown()),
      )
      .max(128)
      .optional(),
    defaultServiceTier: nullableId,
    availabilityNux: z.unknown().optional(),
    additionalSpeedTiers: z.array(idSchema).optional(),
  })
  .catchall(z.unknown())
export type CodexModel = z.infer<typeof modelSchema>
export const modelPageSchema = z.object({
  data: z.array(modelSchema).max(10000),
  nextCursor: cursorSchema,
})
export const skillSchema = z.object({
  name: idSchema,
  description: z.string(),
  enabled: z.boolean(),
  path: absolute,
  scope: idSchema,
  shortDescription: z.string().nullish(),
  pluginId: nullableId,
  interface: z.unknown().optional(),
  dependencies: z.unknown().optional(),
})
export const skillsSchema = z.object({
  data: z
    .array(
      z.object({
        cwd: pathSchema,
        errors: z.array(anyObject),
        skills: z.array(skillSchema).max(10000),
      }),
    )
    .max(10000),
})
export const accountSchema = z.object({
  account: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('apiKey') }),
      z
        .object({
          type: z.literal('chatgpt'),
          email: z.string(),
          planType: z.string(),
        })
        .catchall(z.unknown()),
    ])
    .nullish(),
  requiresOpenaiAuth: z.boolean(),
})

const optionInputSchema = z.strictObject({
  model: nullableId,
  reasoning: nullableId,
  serviceTier: nullableId,
  permissionMode: z.enum(['manual', 'auto', 'yolo']).optional(),
  approvalPolicy: nativeApproval.nullish(),
  sandboxPolicy: nativeSandbox.nullish(),
})
export type CodexDispatchOptions = z.infer<typeof optionInputSchema>
export function parseOptions(value: unknown): CodexDispatchOptions {
  if (value === undefined) return {}
  if (byteSize(value) > 64 * 1024) fail('OPTIONS_LIMIT')
  const result = optionInputSchema.safeParse(value)
  if (!result.success) fail('OPTIONS')
  return result.data
}
export type EffectiveOptions = {
  model?: string
  reasoning?: string
  serviceTier?: string
  permissionMode: 'manual' | 'auto' | 'yolo'
  approvalPolicy: z.infer<typeof nativeApproval>
  approvalsReviewer: 'user' | 'auto_review'
  sandboxPolicy: z.infer<typeof nativeSandbox>
}
function fullSandbox(
  policy: z.infer<typeof nativeSandbox>,
  baseline?: z.infer<typeof nativeSandbox>,
): z.infer<typeof nativeSandbox> {
  if (policy.type === 'workspaceWrite') {
    const defaults = baseline?.type === 'workspaceWrite' ? baseline : undefined
    return {
      type: policy.type,
      writableRoots: policy.writableRoots ?? defaults?.writableRoots ?? [],
      networkAccess: policy.networkAccess ?? defaults?.networkAccess ?? false,
      excludeSlashTmp:
        policy.excludeSlashTmp ?? defaults?.excludeSlashTmp ?? false,
      excludeTmpdirEnvVar:
        policy.excludeTmpdirEnvVar ?? defaults?.excludeTmpdirEnvVar ?? false,
    }
  }
  if (policy.type === 'readOnly')
    return { type: 'readOnly', networkAccess: policy.networkAccess ?? false }
  if (policy.type === 'externalSandbox')
    return {
      type: 'externalSandbox',
      networkAccess: policy.networkAccess ?? 'restricted',
    }
  return policy
}
export class CodexOptions {
  readonly configured: CodexDispatchOptions
  private desired: CodexDispatchOptions
  private nativeValues: Partial<
    Record<'model' | 'reasoning' | 'serviceTier', string>
  > = {}
  constructor(config: Record<string, unknown>, initial?: DispatchOptions) {
    const workspace =
      config.sandbox_workspace_write == null
        ? undefined
        : z
            .strictObject({
              writable_roots: z.array(absolute).optional(),
              network_access: z.boolean().optional(),
              exclude_slash_tmp: z.boolean().optional(),
              exclude_tmpdir_env_var: z.boolean().optional(),
            })
            .parse(config.sandbox_workspace_write)
    let sandbox: CodexDispatchOptions['sandboxPolicy']
    if (config.sandbox_mode != null || workspace) {
      if (config.sandbox_mode === 'danger-full-access')
        sandbox = { type: 'dangerFullAccess' }
      else if (config.sandbox_mode === 'read-only')
        sandbox = { type: 'readOnly', networkAccess: false }
      else if (
        config.sandbox_mode === 'workspace-write' ||
        config.sandbox_mode == null
      )
        sandbox = {
          type: 'workspaceWrite',
          writableRoots: workspace?.writable_roots,
          networkAccess: workspace?.network_access,
          excludeSlashTmp: workspace?.exclude_slash_tmp,
          excludeTmpdirEnvVar: workspace?.exclude_tmpdir_env_var,
        }
      else fail('CONFIG_SANDBOX')
    }
    this.configured = parseOptions({
      model: config.model,
      reasoning: config.model_reasoning_effort,
      serviceTier: config.service_tier,
      approvalPolicy: config.approval_policy,
      sandboxPolicy: sandbox,
      permissionMode: 'manual',
    })
    this.desired = parseOptions(initial)
  }
  resolve(call?: unknown, active?: EffectiveOptions): EffectiveOptions {
    const explicit = parseOptions(call)
    const merged = { ...this.configured }
    const layers = active ? [{ ...active }, explicit] : [this.desired, explicit]
    for (const layer of layers)
      for (const [key, value] of Object.entries(layer))
        if (value !== undefined && key !== 'approvalsReviewer')
          (merged as Record<string, unknown>)[key] = value
    const mode = merged.permissionMode ?? 'manual'
    const baselineSandbox = this.configured.sandboxPolicy ?? {
      type: 'workspaceWrite' as const,
    }
    const result: EffectiveOptions = {
      permissionMode: mode,
      approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user',
      approvalPolicy:
        merged.approvalPolicy ??
        (mode === 'yolo'
          ? 'never'
          : (this.configured.approvalPolicy ?? 'on-request')),
      sandboxPolicy: fullSandbox(
        merged.sandboxPolicy ??
          (mode === 'yolo' ? { type: 'dangerFullAccess' } : baselineSandbox),
        baselineSandbox,
      ),
    }
    // Mode presets must not inherit configured fields as explicit overrides.
    const policyLayers = active ? [active, explicit] : [this.desired, explicit]
    for (const key of ['approvalPolicy', 'sandboxPolicy'] as const) {
      let val: CodexDispatchOptions[typeof key] | undefined
      for (const layer of policyLayers)
        if (layer[key] !== undefined) val = layer[key] as never
      if (
        active &&
        explicit.permissionMode !== undefined &&
        explicit[key] === undefined
      )
        val = undefined
      if (key === 'approvalPolicy')
        result.approvalPolicy =
          (val as EffectiveOptions['approvalPolicy']) ??
          (mode === 'yolo'
            ? 'never'
            : (this.configured.approvalPolicy ?? 'on-request'))
      else
        result.sandboxPolicy = fullSandbox(
          (val as EffectiveOptions['sandboxPolicy']) ??
            (mode === 'yolo' ? { type: 'dangerFullAccess' } : baselineSandbox),
          baselineSandbox,
        )
    }
    for (const key of ['model', 'reasoning', 'serviceTier'] as const) {
      const value = merged[key] ?? this.configured[key] ?? undefined
      if (value === undefined && this.nativeValues[key] !== undefined)
        fail('OPTION_BASELINE_UNAVAILABLE')
      if (value !== undefined) result[key] = value
    }
    if (
      typeof result.approvalPolicy === 'object' &&
      typeof this.configured.approvalPolicy === 'object' &&
      this.configured.approvalPolicy !== null
    ) {
      for (const key of ['request_permissions', 'skill_approval'] as const) {
        const value = this.configured.approvalPolicy.granular[key]
        if (
          result.approvalPolicy.granular[key] === undefined &&
          value !== undefined
        )
          result.approvalPolicy.granular[key] = value
      }
    }
    if (byteSize(result) > 64 * 1024) fail('OPTIONS_LIMIT')
    if (
      active &&
      (!same(
        { ...result, sandboxPolicy: undefined },
        { ...active, sandboxPolicy: undefined },
      ) ||
        !sameSandbox(result.sandboxPolicy, active.sandboxPolicy))
    )
      fail('STEER_OPTIONS')
    return result
  }
  observed(response: NativeThreadResponse, effective: EffectiveOptions) {
    for (const key of ['model', 'reasoning', 'serviceTier'] as const) {
      const native =
        key === 'reasoning' ? response.reasoningEffort : response[key]
      if (
        effective[key] === undefined &&
        this.configured[key] == null &&
        native != null
      )
        this.configured[key] = native
      if (effective[key] !== undefined) this.nativeValues[key] = effective[key]
    }
  }
  sent(effective: EffectiveOptions) {
    for (const key of ['model', 'reasoning', 'serviceTier'] as const)
      if (effective[key] !== undefined) this.nativeValues[key] = effective[key]
  }
  set(value: unknown) {
    this.desired = parseOptions({ ...this.desired, ...parseOptions(value) })
  }
}
export function initialBody(options: EffectiveOptions, cwd: string) {
  const sandbox = options.sandboxPolicy
  if (
    sandbox.type === 'externalSandbox' ||
    (sandbox.type === 'readOnly' && sandbox.networkAccess)
  )
    fail('INITIAL_SANDBOX_UNSUPPORTED')
  const config: Record<string, unknown> = {}
  if (sandbox.type === 'workspaceWrite')
    config.sandbox_workspace_write = {
      writable_roots: sandbox.writableRoots,
      network_access: sandbox.networkAccess,
      exclude_slash_tmp: sandbox.excludeSlashTmp,
      exclude_tmpdir_env_var: sandbox.excludeTmpdirEnvVar,
    }
  if (options.reasoning !== undefined)
    config.model_reasoning_effort = options.reasoning
  return {
    cwd,
    approvalPolicy: options.approvalPolicy,
    approvalsReviewer: options.approvalsReviewer,
    sandbox:
      sandbox.type === 'workspaceWrite'
        ? 'workspace-write'
        : sandbox.type === 'readOnly'
          ? 'read-only'
          : 'danger-full-access',
    ...(Object.keys(config).length ? { config } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.serviceTier !== undefined
      ? { serviceTier: options.serviceTier }
      : {}),
  }
}
export function validateThreadResponse(
  value: unknown,
  cwd: string,
  effective: EffectiveOptions,
  expectedId?: string,
) {
  const parsed = threadResponseSchema.safeParse(value)
  if (!parsed.success) fail('THREAD_RESPONSE')
  const response = parsed.data
  if (
    response.cwd !== cwd ||
    response.thread.cwd !== cwd ||
    response.thread.ephemeral ||
    (expectedId !== undefined && response.thread.id !== expectedId)
  )
    fail('THREAD_BINDING')
  if (
    !same(response.approvalPolicy, effective.approvalPolicy) ||
    response.approvalsReviewer !== effective.approvalsReviewer ||
    !sameSandbox(fullSandbox(response.sandbox), effective.sandboxPolicy)
  )
    fail('THREAD_RESTRICTIONS')
  return response
}

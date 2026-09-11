import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  permissionProfileSchema,
  permissionReplySchema,
  questionAnswerSchema,
  type HarnessEvent,
  type PermissionProfile,
  type PermissionReply,
  type QuestionAnswer,
  type QuestionRequest,
  type PermissionRequest,
} from '@forge/protocol/harness'
import { JsonlRpcTransport, type JsonRpcRequest } from '../jsonrpc.js'
import { byteTail, redactSecrets } from '../diagnostics.js'
import {
  CodexBudget,
  MiB,
  byteSize,
  fail,
  idSchema,
  pathSchema,
  record,
  same,
  tupleId,
} from './wire.js'

export type CodexOwner = {
  runId: string
  turnId: string
  nativeThreadId: string
  nativeTurnId: string
  childId?: string
}
export type EmitOwned = (
  owner: CodexOwner,
  nativeItemId: string,
  event: Record<string, unknown>,
) => void
const questionParams = z.object({
  threadId: idSchema,
  turnId: idSchema,
  itemId: idSchema,
  isBlocking: z.boolean().optional(),
  questions: z
    .array(
      z.object({
        id: idSchema,
        header: z.string(),
        question: z.string(),
        options: z
          .array(z.object({ label: z.string(), description: z.string() }))
          .max(128)
          .nullish(),
        isOther: z.boolean().optional(),
        isSecret: z.boolean().optional(),
      }),
    )
    .max(64),
})
const permissionBase = {
  threadId: idSchema,
  turnId: idSchema,
  itemId: idSchema,
  environmentId: idSchema.nullish(),
  startedAtMs: z.number().int(),
  reason: z.string().nullish(),
}
const commandParams = z.strictObject({
  ...permissionBase,
  command: z.string().nullish(),
  cwd: pathSchema.nullish(),
  approvalId: idSchema.nullish(),
  kind: z.enum(['command', 'writeStdin']).optional(),
  commandActions: z.array(z.unknown()).nullish(),
  networkApprovalContext: z
    .object({ host: z.string(), protocol: z.string() })
    .nullish(),
  proposedExecpolicyAmendment: z.array(z.string()).max(128).nullish(),
  proposedNetworkPolicyAmendments: z
    .array(z.object({ action: z.enum(['allow', 'deny']), host: z.string() }))
    .max(128)
    .nullish(),
})
const fileParams = z.strictObject({
  threadId: idSchema,
  turnId: idSchema,
  itemId: idSchema,
  reason: z.string().nullish(),
  grantRoot: pathSchema.nullish(),
  startedAtMs: z.number().int(),
})
const grantParams = z.strictObject({
  ...permissionBase,
  cwd: pathSchema,
  permissions: permissionProfileSchema,
})
const unsupported = { action: 'decline', content: null }

type AnswerMap = Record<string, QuestionAnswer>
type Presented =
  | {
      type: 'permission'
      request: PermissionRequest
      answer: (value: PermissionReply) => unknown
    }
  | {
      type: 'question'
      request: QuestionRequest
      answer: (value: AnswerMap) => unknown
    }

function validateAnswerKeys(answers: AnswerMap, keys: string[]) {
  if (
    !record(answers) ||
    Object.keys(answers).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(answers, key))
  )
    fail('QUESTION_ANSWERS')
  for (const answer of Object.values(answers))
    questionAnswerSchema.parse(answer)
}
function optionsFor<T>(
  values: readonly T[],
  label: (value: T, i: number) => string,
) {
  const choices = values.map((value, i) => ({
    id: randomUUID(),
    label: label(value, i),
    value,
  }))
  return { choices, public: choices.map(({ id, label }) => ({ id, label })) }
}
function selectedValues<T>(
  answer: QuestionAnswer,
  choices: { id: string; value: T }[],
  multi = false,
) {
  if (answer.type !== 'selected' && answer.type !== 'selected_with_text')
    fail('QUESTION_SELECTION')
  if (
    (!multi && answer.optionIds.length !== 1) ||
    new Set(answer.optionIds).size !== answer.optionIds.length
  )
    fail('QUESTION_SELECTION')
  return answer.optionIds.map((id) => {
    const found = choices.find((choice) => choice.id === id)
    if (!found) return fail('QUESTION_SELECTION')
    return found.value
  })
}

export function validatePermissionSubset(
  requested: PermissionProfile,
  value: PermissionProfile,
) {
  const granted = permissionProfileSchema.parse(value)
  if (granted.network?.enabled === true && requested.network?.enabled !== true)
    fail('PERMISSION_SCOPE')
  const fs = granted.fileSystem
  const original = requested.fileSystem
  if (fs) {
    if (!original) fail('PERMISSION_SCOPE')
    const positive =
      !!fs.entries?.some((entry) => entry.access !== 'deny') ||
      !!fs.read?.length ||
      !!fs.write?.length
    if (positive) {
      const denies =
        original.entries?.filter((entry) => entry.access === 'deny') ?? []
      if (
        !denies.every((entry) =>
          fs.entries?.some((candidate) => same(entry, candidate)),
        )
      )
        fail('PERMISSION_DENY_REQUIRED')
      if (
        original.globScanMaxDepth != null &&
        fs.globScanMaxDepth !== original.globScanMaxDepth
      )
        fail('PERMISSION_DEPTH')
    }
    if (
      fs.globScanMaxDepth != null &&
      original.globScanMaxDepth != null &&
      fs.globScanMaxDepth > original.globScanMaxDepth
    )
      fail('PERMISSION_DEPTH')
    for (const entry of fs.entries ?? [])
      if (!original.entries?.some((candidate) => same(entry, candidate)))
        fail('PERMISSION_SCOPE')
    for (const key of ['read', 'write'] as const)
      for (const path of fs[key] ?? [])
        if (!original[key]?.includes(path)) fail('PERMISSION_SCOPE')
  }
  return granted
}

function permissionPresentation(
  method: string,
  params: unknown,
  requestId: string,
  toolCallId: string,
  secrets: readonly string[],
): Presented {
  if (method === 'item/permissions/requestApproval') {
    const data = grantParams.parse(params)
    if (data.environmentId != null) fail('ENVIRONMENT_UNSUPPORTED')
    return {
      type: 'permission',
      request: {
        requestId,
        toolCallId,
        title: 'Grant permissions',
        detail: byteTail(
          redactSecrets(JSON.stringify(data), secrets),
          64 * 1024,
        ),
        options: [],
        permissions: data.permissions,
        scope: 'turn',
      },
      answer: (reply) => {
        if (reply.type === 'denied') return { permissions: {}, scope: 'turn' }
        if (reply.type !== 'granted') fail('PERMISSION_REPLY')
        return {
          permissions: validatePermissionSubset(
            data.permissions,
            reply.permissions,
          ),
          scope: reply.scope,
          ...(Object.hasOwn(reply, 'strictAutoReview')
            ? { strictAutoReview: reply.strictAutoReview }
            : {}),
        }
      },
    }
  }
  const command = method === 'item/commandExecution/requestApproval'
  const data = command ? commandParams.parse(params) : fileParams.parse(params)
  if ('environmentId' in data && data.environmentId != null)
    fail('ENVIRONMENT_UNSUPPORTED')
  const native: { label: string; value: unknown }[] = [
    { label: 'Allow once', value: 'accept' },
    { label: 'Allow for this session', value: 'acceptForSession' },
    { label: 'Deny', value: 'decline' },
    { label: 'Cancel turn', value: 'cancel' },
  ]
  if ('proposedExecpolicyAmendment' in data && data.proposedExecpolicyAmendment)
    native.push({
      label: 'Allow and save command rule',
      value: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: data.proposedExecpolicyAmendment,
        },
      },
    })
  if ('proposedNetworkPolicyAmendments' in data)
    for (const amendment of data.proposedNetworkPolicyAmendments ?? [])
      native.push({
        label: `Save network rule: ${amendment.action} ${amendment.host}`,
        value: {
          applyNetworkPolicyAmendment: { network_policy_amendment: amendment },
        },
      })
  const options = optionsFor(native, (choice) => choice.label)
  const title = !command
    ? 'Approve file changes'
    : 'networkApprovalContext' in data && data.networkApprovalContext
      ? 'Approve network access'
      : 'kind' in data && data.kind === 'writeStdin'
        ? 'Approve terminal input'
        : 'Approve command'
  return {
    type: 'permission',
    request: {
      requestId,
      toolCallId,
      title,
      detail: byteTail(redactSecrets(JSON.stringify(data), secrets), 64 * 1024),
      options: options.public,
      ...('approvalId' in data && data.approvalId != null
        ? { approvalId: data.approvalId }
        : {}),
      ...('kind' in data && data.kind ? { kind: data.kind } : {}),
    },
    answer: (reply) => {
      if (reply.type === 'denied') return { decision: 'decline' }
      if (
        reply.type !== 'selected' ||
        reply.grant !== undefined ||
        reply.scope !== undefined
      )
        fail('PERMISSION_REPLY')
      const choice = options.choices.find(
        (choice) => choice.id === reply.optionId,
      )
      if (!choice) fail('PERMISSION_OPTION')
      return { decision: choice.value.value }
    },
  }
}
function questionPresentation(params: unknown, requestId: string): Presented {
  const data = questionParams.parse(params)
  if (
    new Set(data.questions.map((question) => question.id)).size !==
    data.questions.length
  )
    fail('QUESTION_ID')
  const maps = data.questions.map((question) => ({
    question,
    options: optionsFor(question.options ?? [], (option) => option.label),
  }))
  return {
    type: 'question',
    request: {
      requestId,
      ...(data.isBlocking === undefined ? {} : { isBlocking: data.isBlocking }),
      questions: maps.map(({ question, options }) => ({
        id: question.id,
        header: question.header,
        question: question.question,
        options: options.public.map((option, i) => ({
          ...option,
          description: options.choices[i]!.value.description,
        })),
        multiSelect: false,
        allowFreeInput: question.isOther === true || question.options == null,
        ...(question.isSecret === undefined
          ? {}
          : { isSecret: question.isSecret }),
      })),
    },
    answer: (answers) => {
      validateAnswerKeys(
        answers,
        maps.map(({ question }) => question.id),
      )
      return {
        answers: Object.fromEntries(
          maps.map(({ question, options }) => {
            const answer = answers[question.id]!
            let values: string[]
            if (answer.type === 'skipped') values = []
            else if (answer.type === 'free_text') {
              if (!question.isOther && question.options != null)
                fail('QUESTION_FREE_TEXT')
              values = [answer.text]
            } else {
              values = selectedValues(answer, options.choices).map(
                (value) => value.label,
              )
              if (answer.type === 'selected_with_text') {
                if (!question.isOther) fail('QUESTION_FREE_TEXT')
                values.push(answer.text)
              }
            }
            return [question.id, { answers: values }]
          }),
        ),
      }
    },
  }
}

const propertyCommon = {
  title: z.string().nullish(),
  description: z.string().nullish(),
}
const stringForm = z.strictObject({
  ...propertyCommon,
  type: z.literal('string'),
  minLength: z.number().int().nonnegative().nullish(),
  maxLength: z.number().int().nonnegative().nullish(),
  format: z.enum(['email', 'uri', 'date', 'date-time']).nullish(),
  default: z.string().nullish(),
})
const numberForm = z.strictObject({
  ...propertyCommon,
  type: z.enum(['number', 'integer']),
  minimum: z.number().finite().nullish(),
  maximum: z.number().finite().nullish(),
  default: z.number().finite().nullish(),
})
const booleanForm = z.strictObject({
  ...propertyCommon,
  type: z.literal('boolean'),
  default: z.boolean().nullish(),
})
const titledChoice = z.strictObject({ const: z.string(), title: z.string() })
const enumForm = z.strictObject({
  ...propertyCommon,
  type: z.literal('string'),
  enum: z.array(z.string()).max(128).optional(),
  enumNames: z.array(z.string()).max(128).nullish(),
  oneOf: z.array(titledChoice).max(128).optional(),
  default: z.string().nullish(),
})
const arrayForm = z.strictObject({
  ...propertyCommon,
  type: z.literal('array'),
  items: z.strictObject({
    type: z.literal('string').optional(),
    enum: z.array(z.string()).max(128).optional(),
    anyOf: z.array(titledChoice).max(128).optional(),
  }),
  minItems: z.number().int().nonnegative().nullish(),
  maxItems: z.number().int().nonnegative().nullish(),
  default: z.array(z.string()).nullish(),
})
const formSchema = z.strictObject({
  $schema: z.string().nullish(),
  type: z.literal('object'),
  properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()).nullish(),
})

export function mapMcpForm(params: unknown, requestId: string): Presented {
  if (
    !record(params) ||
    params.mode !== 'form' ||
    typeof params.message !== 'string'
  )
    fail('MCP_FORM_UNSUPPORTED')
  const schema = formSchema.parse(params.requestedSchema)
  const entries = Object.entries(schema.properties)
  if (
    entries.length > 64 ||
    new Set(schema.required ?? []).size !== (schema.required ?? []).length ||
    schema.required?.some((key) => !Object.hasOwn(schema.properties, key))
  )
    fail('MCP_FORM_UNSUPPORTED')
  const fields = entries.map(([key, raw]) => {
    idSchema.parse(key)
    if (!record(raw)) fail('MCP_FORM_UNSUPPORTED')
    const required = schema.required?.includes(key) ?? false
    let choices: { id: string; label: string; value: string | boolean }[] = []
    let multiSelect = false
    let allowFreeInput = false
    let parse: (answer: QuestionAnswer) => unknown
    if (raw.type === 'boolean') {
      booleanForm.parse(raw)
      choices = optionsFor([true, false], (value) => String(value)).choices
      parse = (answer) => {
        if (answer.type !== 'selected') fail('MCP_BOOLEAN')
        return selectedValues(answer, choices)[0]
      }
    } else if (raw.type === 'number' || raw.type === 'integer') {
      const spec = numberForm.parse(raw)
      if (
        spec.type === 'integer' &&
        [spec.minimum, spec.maximum].some(
          (bound) => bound != null && !Number.isSafeInteger(bound),
        )
      )
        fail('MCP_FORM_UNSUPPORTED')
      if (
        spec.minimum != null &&
        spec.maximum != null &&
        spec.minimum > spec.maximum
      )
        fail('MCP_FORM_UNSUPPORTED')
      allowFreeInput = true
      parse = (answer) => {
        if (
          answer.type !== 'free_text' ||
          !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(answer.text)
        )
          fail('MCP_NUMBER')
        const number = Number(answer.text)
        if (
          !Number.isFinite(number) ||
          (spec.type === 'integer' && !Number.isSafeInteger(number)) ||
          (spec.minimum != null && number < spec.minimum) ||
          (spec.maximum != null && number > spec.maximum)
        )
          fail('MCP_NUMBER')
        return number
      }
    } else if (raw.type === 'array' || 'enum' in raw || 'oneOf' in raw) {
      const spec =
        raw.type === 'array' ? arrayForm.parse(raw) : enumForm.parse(raw)
      multiSelect = spec.type === 'array'
      const values = spec.type === 'array' ? spec.items.enum : spec.enum
      const titled = spec.type === 'array' ? spec.items.anyOf : spec.oneOf
      if (!!values === !!titled) fail('MCP_ENUM')
      if (
        spec.type === 'array' &&
        spec.minItems != null &&
        spec.maxItems != null &&
        spec.minItems > spec.maxItems
      )
        fail('MCP_ENUM')
      const names = spec.type === 'string' ? spec.enumNames : null
      if (names && names.length !== values?.length) fail('MCP_ENUM')
      const native = values ?? titled!.map((choice) => choice.const)
      if (!native.length || new Set(native).size !== native.length)
        fail('MCP_ENUM')
      choices = optionsFor(
        native,
        (value, i) => names?.[i] ?? titled?.[i]?.title ?? value,
      ).choices
      parse = (answer) => {
        if (answer.type !== 'selected') fail('MCP_ENUM')
        const values = selectedValues(answer, choices, multiSelect)
        if (spec.type === 'array') {
          if (
            (spec.minItems != null && values.length < spec.minItems) ||
            (spec.maxItems != null && values.length > spec.maxItems)
          )
            fail('MCP_ENUM')
          return values
        }
        return values[0]
      }
    } else {
      const spec = stringForm.parse(raw)
      if (
        spec.minLength != null &&
        spec.maxLength != null &&
        spec.minLength > spec.maxLength
      )
        fail('MCP_FORM_UNSUPPORTED')
      allowFreeInput = true
      parse = (answer) => {
        if (answer.type !== 'free_text') fail('MCP_STRING')
        const value = answer.text
        const length = [...value].length
        if (
          (spec.minLength != null && length < spec.minLength) ||
          (spec.maxLength != null && length > spec.maxLength)
        )
          fail('MCP_STRING')
        if (spec.format === 'email') z.email().parse(value)
        if (spec.format === 'uri') z.url().parse(value)
        if (spec.format === 'date') z.iso.date().parse(value)
        if (spec.format === 'date-time')
          z.iso.datetime({ offset: true }).parse(value)
        return value
      }
    }
    return {
      key,
      required,
      parse,
      public: {
        id: key,
        header: typeof raw.title === 'string' ? raw.title : key,
        question:
          typeof raw.description === 'string'
            ? raw.description
            : (params.message as string),
        options: choices.map(({ id, label }) => ({ id, label })),
        multiSelect,
        allowFreeInput,
      },
    }
  })
  return {
    type: 'question',
    request: { requestId, questions: fields.map((field) => field.public) },
    answer: (answers) => {
      validateAnswerKeys(
        answers,
        fields.map((field) => field.key),
      )
      const values: [string, unknown][] = []
      for (const field of fields) {
        const answer = answers[field.key]!
        if (answer.type === 'skipped') {
          if (field.required) fail('MCP_REQUIRED')
          continue
        }
        values.push([field.key, field.parse(answer)])
      }
      return { action: 'accept', content: Object.fromEntries(values) }
    },
  }
}

type Pending = {
  original: JsonRpcRequest
  owner: CodexOwner
  itemId: string
  presentation: Presented
  release: ReturnType<CodexBudget['charge']>
  bytes: number
  removeAbort: () => void
  replying: boolean
}
export class CodexRequests {
  private readonly pending = new Map<string, Pending>()
  private readonly native = new Map<string, string>()
  constructor(
    private readonly rpc: JsonlRpcTransport,
    private readonly emit: EmitOwned,
    private readonly budget: CodexBudget,
    private readonly secrets: readonly string[] = [],
  ) {}
  get size() {
    return this.pending.size
  }
  receive(original: JsonRpcRequest, owner: CodexOwner) {
    if (typeof original.id === 'string') idSchema.parse(original.id)
    const params = original.params
    if (!record(params)) return this.unsupported(original)
    if (
      params.threadId !== owner.nativeThreadId ||
      params.turnId !== owner.nativeTurnId ||
      original.signal.aborted
    )
      return this.unsupported(original)
    const requestId = randomUUID()
    const itemId =
      typeof params.itemId === 'string'
        ? idSchema.parse(params.itemId)
        : `mcp-${requestId}`
    let presentation: Presented
    try {
      if (byteSize(params) > 4 * MiB) fail('CALLBACK_LIMIT')
      if (original.method === 'item/tool/requestUserInput')
        presentation = questionPresentation(params, requestId)
      else if (original.method === 'mcpServer/elicitation/request')
        presentation = mapMcpForm(params, requestId)
      else if (
        [
          'item/commandExecution/requestApproval',
          'item/fileChange/requestApproval',
          'item/permissions/requestApproval',
        ].includes(original.method)
      )
        presentation = permissionPresentation(
          original.method,
          params,
          requestId,
          tupleId(owner.nativeThreadId, owner.nativeTurnId, itemId, 'tool'),
          this.secrets,
        )
      else return this.unsupported(original)
    } catch {
      return this.unsupported(original)
    }
    const nativeKey = tupleId(
      owner.nativeThreadId,
      typeof original.id,
      String(original.id),
    )
    const bytes =
      byteSize(params) * 2 +
      byteSize(presentation.request) * 2 +
      byteSize(owner) +
      byteSize(nativeKey) +
      256
    const callbackCharge = this.budget.charge('callbacks', bytes, 128, 4 * MiB)
    let releaseControl: () => void
    try {
      releaseControl = this.budget.charge(
        'control-resources',
        256,
        512,
        256 * 1024,
      )
    } catch (error) {
      callbackCharge()
      throw error
    }
    const release = Object.assign(
      () => {
        callbackCharge()
        releaseControl()
      },
      { resize: callbackCharge.resize },
    )
    const abort = () => this.expire(requestId, 'Native request expired')
    const pending: Pending = {
      original,
      owner,
      itemId,
      presentation,
      release,
      bytes,
      replying: false,
      removeAbort: () => original.signal.removeEventListener('abort', abort),
    }
    this.pending.set(requestId, pending)
    this.native.set(nativeKey, requestId)
    original.signal.addEventListener('abort', abort, { once: true })
    this.emit(owner, itemId, {
      type:
        presentation.type === 'question'
          ? 'question_requested'
          : 'permission_requested',
      request: presentation.request,
    })
  }
  unsupported(original: JsonRpcRequest) {
    return (
      original.method === 'mcpServer/elicitation/request'
        ? this.rpc.respond(original, unsupported)
        : this.rpc.respondError(
            original,
            -32601,
            'Codex callback is unsupported',
          )
    ).catch(() => {})
  }
  resolve(threadId: string, id: string | number) {
    idSchema.parse(threadId)
    const requestId = this.native.get(tupleId(threadId, typeof id, String(id)))
    if (requestId) this.expire(requestId, 'Native request resolved')
  }
  expire(requestId: string, reason: string) {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.remove(requestId, pending)
    this.rpc.dismiss(pending.original)
    this.emit(pending.owner, pending.itemId, {
      type: 'request_cancelled',
      requestId,
      reason,
    })
  }
  expireAll(reason: string) {
    for (const id of this.pending.keys()) this.expire(id, reason)
  }
  replyPermission(reply: PermissionReply) {
    permissionReplySchema.parse(reply)
    return this.reply(reply.requestId, 'permission', reply)
  }
  replyQuestion(requestId: string, answers: AnswerMap) {
    return this.reply(requestId, 'question', answers)
  }
  private reply(
    id: string,
    type: Presented['type'],
    value: PermissionReply | AnswerMap,
  ) {
    const pending = this.pending.get(id)
    if (
      !pending ||
      pending.replying ||
      pending.presentation.type !== type ||
      pending.original.signal.aborted
    )
      return Promise.reject(new Error('CODEX_REQUEST_STALE'))
    let result: unknown
    try {
      result =
        pending.presentation.type === 'permission'
          ? pending.presentation.answer(value as PermissionReply)
          : pending.presentation.answer(value as AnswerMap)
    } catch {
      return Promise.reject(new Error('CODEX_REQUEST_REPLY_INVALID'))
    }
    try {
      pending.release.resize(pending.bytes + byteSize(result) + 128)
    } catch {
      return Promise.reject(new Error('CODEX_CALLBACK_LIMIT'))
    }
    pending.replying = true
    // Remove the abort callback during successful router dismissal; failure restores answerability.
    pending.removeAbort()
    return this.rpc
      .respond(pending.original, result)
      .then(
        () => this.remove(id, pending),
        (error: unknown) => {
          if (
            this.pending.get(id) === pending &&
            !pending.original.signal.aborted
          ) {
            pending.replying = false
            const abort = () => this.expire(id, 'Native request expired')
            pending.original.signal.addEventListener('abort', abort, {
              once: true,
            })
            pending.removeAbort = () =>
              pending.original.signal.removeEventListener('abort', abort)
          }
          throw error
        },
      )
      .finally(() => {
        if (this.pending.get(id) === pending)
          pending.release.resize(pending.bytes)
      })
  }
  private remove(id: string, pending: Pending) {
    if (this.pending.get(id) !== pending) return
    this.pending.delete(id)
    this.native.delete(
      tupleId(
        pending.owner.nativeThreadId,
        typeof pending.original.id,
        String(pending.original.id),
      ),
    )
    pending.removeAbort()
    pending.release()
  }
}

// Ensure emitted request payloads keep the public contract during direct use.
export type CodexRequestEvent = Extract<
  HarnessEvent,
  { type: 'permission_requested' | 'question_requested' | 'request_cancelled' }
>

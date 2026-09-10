import { describe, expect, it } from 'vitest'
import * as native from '../src/harness.js'

const envelope = { runId: 'r', runtimeGeneration: 'g', deliveryId: 'd' }
const permissionRequest = {
  requestId: 'p',
  toolCallId: null,
  title: 'Permissions',
  options: [],
}
// Codex 0.153.4: TurnStartParams AskForApproval and SandboxPolicy captures.
const granular = {
  granular: {
    sandbox_approval: false,
    rules: true,
    mcp_elicitations: true,
    request_permissions: false,
    skill_approval: false,
  },
}
const sandboxes = [
  { type: 'dangerFullAccess' },
  { type: 'readOnly', networkAccess: false },
  { type: 'externalSandbox', networkAccess: 'restricted' },
  { type: 'externalSandbox', networkAccess: 'enabled' },
  {
    type: 'workspaceWrite',
    writableRoots: ['/repo'],
    networkAccess: false,
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
  },
]
// Codex 0.153.4: PermissionsRequestApprovalResponse filesystem path variants.
const paths = [
  { type: 'path', path: '/repo/file' },
  { type: 'glob_pattern', pattern: '/repo/**' },
  ...['root', 'minimal', 'tmpdir', 'slash_tmp'].map((kind) => ({
    type: 'special',
    value: { kind },
  })),
  { type: 'special', value: { kind: 'project_roots', subpath: 'src' } },
  { type: 'special', value: { kind: 'project_roots', subpath: null } },
  {
    type: 'special',
    value: { kind: 'unknown', path: 'future_root', subpath: 'src' },
  },
]
const profile = {
  network: { enabled: false },
  fileSystem: {
    entries: paths.map((path, i) => ({
      path,
      access: ['read', 'write', 'deny'][i % 3],
    })),
    globScanMaxDepth: 4,
    read: ['/repo/read'],
    write: ['/repo/write'],
  },
}

describe('native policy and request contracts', () => {
  it.each(['untrusted', 'on-request', 'never', granular])(
    'retains approval policy %j',
    (approvalPolicy) => {
      const input = { permissionMode: 'manual', approvalPolicy }
      expect(native.dispatchOptionsSchema.parse(input)).toEqual(input)
    },
  )

  it.each(sandboxes)('retains sandbox restrictions %j', (sandboxPolicy) => {
    const input = { permissionMode: 'manual', sandboxPolicy }
    expect(native.dispatchOptionsSchema.parse(input)).toEqual(input)
  })

  it('retains nullable native turn overrides', () => {
    const options = {
      permissionMode: 'manual',
      approvalPolicy: null,
      sandboxPolicy: null,
      serviceTier: null,
      model: null,
      reasoning: null,
    }
    expect(native.dispatchOptionsSchema.parse(options)).toEqual(options)
  })

  it('rejects malformed sandbox and approval controls instead of discarding them', () => {
    for (const input of [
      { approvalPolicy: { granular: { rules: true } } },
      { approvalPolicy: { granular: { ...granular.granular, rules: 'yes' } } },
      { sandboxPolicy: { type: 'workspaceWrite', excludeSlashTmp: 'true' } },
      { sandboxPolicy: { type: 'externalSandbox', networkAccess: false } },
      { sandboxPolicy: { type: 'readOnly', writableRoots: ['/repo'] } },
    ])
      expect(native.dispatchOptionsSchema.safeParse(input).success).toBe(false)
  })

  it.each(['turn', 'session'])(
    'preserves typed grants and review restrictions for %s',
    (scope) => {
      const request = { ...permissionRequest, permissions: profile, scope }
      expect(native.permissionRequestSchema.parse(request)).toEqual(request)
      const reply = {
        type: 'granted',
        requestId: 'p',
        permissions: profile,
        scope,
        strictAutoReview: true,
      }
      expect(native.permissionReplySchema.parse(reply)).toEqual(reply)
      const selected = {
        type: 'selected',
        requestId: 'p',
        optionId: 'allow',
        grant: profile,
        scope,
      }
      expect(native.permissionReplySchema.parse(selected)).toEqual(selected)
    },
  )

  it('preserves nullable and absent native grant values without inventing grants', () => {
    for (const permissions of [
      {},
      { network: null, fileSystem: null },
      {
        network: { enabled: null },
        fileSystem: {
          entries: null,
          read: null,
          write: null,
          globScanMaxDepth: null,
        },
      },
    ]) {
      const reply = {
        type: 'granted',
        requestId: 'p',
        permissions,
        scope: 'turn',
        strictAutoReview: null,
      }
      expect(native.permissionReplySchema.parse(reply)).toEqual(reply)
    }
  })

  it.each([
    42,
    [],
    null,
    { network: { enabled: 'yes' } },
    { network: { allowEverything: true } },
    {
      fileSystem: {
        entries: [{ path: { type: 'path', path: 3 }, access: 'read' }],
      },
    },
    {
      fileSystem: {
        entries: [{ path: { type: 'path', path: '/repo' }, access: 'execute' }],
      },
    },
    {
      fileSystem: {
        entries: [
          {
            path: { type: 'special', value: { kind: 'unknown' } },
            access: 'write',
          },
        ],
      },
    },
    { fileSystem: { globScanMaxDepth: 0 } },
    { fileSystem: { globScanMaxDepth: 1.5 } },
  ])('rejects malformed permission profile %j', (permissions) => {
    expect(
      native.permissionRequestSchema.safeParse({
        ...permissionRequest,
        permissions,
      }).success,
    ).toBe(false)
    expect(
      native.permissionReplySchema.safeParse({
        type: 'granted',
        requestId: 'p',
        permissions,
        scope: 'turn',
      }).success,
    ).toBe(false)
    expect(
      native.permissionReplySchema.safeParse({
        type: 'selected',
        requestId: 'p',
        optionId: 'allow',
        grant: permissions,
      }).success,
    ).toBe(false)
  })

  it('rejects unsupported grant scope and malformed strict review', () => {
    for (const scope of ['run', 'forever', 42]) {
      expect(
        native.permissionRequestSchema.safeParse({
          ...permissionRequest,
          permissions: {},
          scope,
        }).success,
      ).toBe(false)
      expect(
        native.permissionReplySchema.safeParse({
          type: 'granted',
          requestId: 'p',
          permissions: {},
          scope,
        }).success,
      ).toBe(false)
    }
    expect(
      native.permissionReplySchema.safeParse({
        type: 'granted',
        requestId: 'p',
        permissions: {},
        scope: 'turn',
        strictAutoReview: 'yes',
      }).success,
    ).toBe(false)
  })

  it.each([true, false])(
    'preserves request-level isBlocking=%s and question secrecy',
    (isBlocking) => {
      const request = {
        requestId: 'q',
        isBlocking,
        questions: [
          {
            id: 'answer',
            question: 'Secret?',
            options: [],
            multiSelect: false,
            allowFreeInput: true,
            isSecret: true,
          },
        ],
      }
      expect(native.questionRequestSchema.parse(request)).toEqual(request)
    },
  )

  it.each([
    { type: 'selected', optionIds: ['single-id'] },
    { type: 'selected', optionIds: ['first-id', 'second-id'] },
    { type: 'free_text', text: 'other' },
    {
      type: 'selected_with_text',
      optionIds: ['first-id', 'second-id'],
      text: 'other',
    },
    { type: 'skipped' },
  ])('preserves normalized Kimi answer %j', (answer) => {
    expect(native.questionAnswerSchema.parse(answer)).toEqual(answer)
  })
})

describe('shared terminal outcomes', () => {
  it.each([
    { status: 'completed' },
    { status: 'interrupted', reason: 'user cancelled' },
    { status: 'failed', code: 'E_PROVIDER', message: 'provider failed' },
  ])(
    'preserves the same outcome in events and completion results: %j',
    (outcome) => {
      const event = {
        ...envelope,
        type: 'turn_completed',
        turnId: 't',
        outcome,
      }
      expect(native.harnessEventSchema.parse(event)).toEqual(event)
      const result = { ...outcome, runId: 'r', turnId: 't' }
      expect(native.completionResultSchema.parse(result)).toEqual(result)
    },
  )

  it.each([
    { status: 'completed' },
    { status: 'interrupted', reason: 'parent cancelled' },
    { status: 'failed', code: 'E_CHILD', message: 'child failed' },
  ])('uses the shared terminal outcome for child completion: %j', (outcome) => {
    const event = {
      ...envelope,
      type: 'child_finished',
      turnId: 't',
      itemId: 'i',
      childId: 'child',
      outcome,
    }
    expect(native.harnessEventSchema.parse(event)).toEqual(event)
  })

  it.each([
    undefined,
    { status: 'inProgress' },
    { status: 'failed' },
    { status: 'failed', code: 42, message: 'bad' },
  ])('rejects malformed terminal outcome %j', (outcome) => {
    expect(
      native.harnessEventSchema.safeParse({
        ...envelope,
        type: 'turn_completed',
        turnId: 't',
        outcome,
      }).success,
    ).toBe(false)
  })

  it('requires typed neutral and native event identities', () => {
    const valid = {
      ...envelope,
      type: 'text_delta',
      turnId: 't',
      itemId: 'i',
      text: 'x',
    }
    for (const key of [
      'runId',
      'runtimeGeneration',
      'deliveryId',
      'turnId',
      'itemId',
    ]) {
      for (const value of [undefined, '', 42, [], {}])
        expect(
          native.harnessEventSchema.safeParse({ ...valid, [key]: value })
            .success,
        ).toBe(false)
    }
    for (const key of ['providerRunId', 'providerTurnId', 'providerItemId'])
      expect(
        native.harnessEventSchema.safeParse({ ...valid, [key]: 42 }).success,
      ).toBe(false)
  })
})

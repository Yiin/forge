import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core'

export const workspaceTargetRevisions = sqliteTable(
  'workspace_target_revisions',
  {
    targetKey: text('target_key').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    checkoutKey: text('checkout_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    revision: integer('revision').notNull(),
  },
)

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull(),
  createdAt: integer('created_at').notNull(),
  archivedAt: integer('archived_at'),
  deletedAt: integer('deleted_at'),
})
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id),
  harness: text('harness').notNull(),
  title: text('title').notNull(),
  cwd: text('cwd').notNull(),
  worktreePath: text('worktree_path'),
  branch: text('branch'),
  providerSessionId: text('provider_session_id'),
  adapterKind: text('adapter_kind'),
  nativeResumeState: text('native_resume_state')
    .notNull()
    .default('not_eligible'),
  nativeResumeError: text('native_resume_error'),
  model: text('model'),
  kind: text('kind').notNull(),
  retention: text('retention').notNull().default('permanent'),
  parentSessionId: text('parent_session_id'),
  forkedAtSeq: integer('forked_at_seq'),
  spawnedBySeq: integer('spawned_by_seq'),
  epicRunId: text('epic_run_id'),
  accountId: text('account_id'),
  status: text('status').notNull(),
  autoResume: integer('auto_resume').notNull(),
  createdAt: integer('created_at').notNull(),
  lastActivityAt: integer('last_activity_at').notNull(),
  deletedAt: integer('deleted_at'),
})
export const nativeSessionBindings = sqliteTable('native_session_bindings', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id),
  provider: text('provider').notNull(),
  accountId: text('account_id'),
  cwd: text('cwd').notNull(),
  providerSessionId: text('provider_session_id'),
  state: text('state').notNull().default('available'),
  error: text('error'),
  updatedAt: integer('updated_at').notNull(),
})
export const messages = sqliteTable(
  'messages',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    turnId: text('turn_id').notNull(),
    itemId: text('item_id').notNull(),
    role: text('role').notNull(),
    type: text('type').notNull(),
    content: text('content').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('messages_session_seq_idx').on(table.sessionId, table.seq)],
)
export const nativeInteractions = sqliteTable(
  'native_interactions',
  {
    requestId: text('request_id').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    runtimeGeneration: text('runtime_generation'),
    kind: text('kind').notNull(),
    request: text('request').notNull(),
    status: text('status').notNull(),
    answer: text('answer'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.requestId] }),
    index('native_interactions_session_idx').on(table.sessionId),
  ],
)
// Epic iteration provider columns are added by migration 0008.
export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id),
  messageSeq: integer('message_seq'),
  filename: text('filename').notNull(),
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256'),
  relPath: text('rel_path'),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
})

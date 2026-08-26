import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull(),
  createdAt: integer('created_at').notNull(),
  archivedAt: integer('archived_at'),
})
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  harness: text('harness').notNull(),
  title: text('title').notNull(),
  cwd: text('cwd').notNull(),
  worktreePath: text('worktree_path'),
  providerSessionId: text('provider_session_id'),
  kind: text('kind').notNull(),
  retention: text('retention').notNull().default('permanent'),
  parentSessionId: text('parent_session_id'),
  forkedAtSeq: integer('forked_at_seq'),
  spawnedBySeq: integer('spawned_by_seq'),
  epicRunId: text('epic_run_id'),
  status: text('status').notNull(),
  autoResume: integer('auto_resume').notNull(),
  createdAt: integer('created_at').notNull(),
  lastActivityAt: integer('last_activity_at').notNull(),
  deletedAt: integer('deleted_at'),
})
export const messages = sqliteTable(
  'messages',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    turnId: text('turn_id').notNull(),
    itemId: text('item_id').notNull(),
    role: text('role').notNull(),
    type: text('type').notNull(),
    content: text('content').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('messages_session_seq_idx').on(table.sessionId, table.seq)],
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

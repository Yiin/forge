ALTER TABLE queued_prompts ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queued_prompts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queued_prompts ADD COLUMN lease_id TEXT;
CREATE INDEX IF NOT EXISTS queued_prompts_order_idx
  ON queued_prompts(session_id, position, created_at, id);

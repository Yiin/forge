ALTER TABLE queued_prompts ADD COLUMN prompt_parts TEXT;
ALTER TABLE queued_prompts ADD COLUMN review_references TEXT;
ALTER TABLE queued_prompts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queued_prompts ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE queued_prompts ADD COLUMN lease_id TEXT;
ALTER TABLE queued_prompts ADD COLUMN lease_until INTEGER;
ALTER TABLE queued_prompts ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0;

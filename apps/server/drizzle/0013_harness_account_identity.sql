ALTER TABLE harness_accounts ADD COLUMN identity TEXT;
ALTER TABLE harness_accounts ADD COLUMN identity_checked_at INTEGER;
ALTER TABLE harness_accounts ADD COLUMN label_auto_generated INTEGER NOT NULL DEFAULT 0;

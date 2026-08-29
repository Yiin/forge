-- draft_promotions keyed by promotion attempt, not by draft.
-- Drafts are reused across sessions (one unpromoted draft per project),
-- so draft_id cannot be unique: each promotion attempt carries its own
-- request_id, and only retries of the same attempt share one.
CREATE TABLE draft_promotions_new (
  request_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id)
);
INSERT INTO draft_promotions_new (request_id, draft_id, session_id)
  SELECT request_id, draft_id, session_id FROM draft_promotions;
DROP TABLE draft_promotions;
ALTER TABLE draft_promotions_new RENAME TO draft_promotions;

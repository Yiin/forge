ALTER TABLE epic_runs ADD COLUMN origin_session_id TEXT REFERENCES sessions(id);

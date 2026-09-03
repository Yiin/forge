CREATE TABLE IF NOT EXISTS server_boots (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  stopped_at INTEGER
);

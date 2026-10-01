// WAL lets other processes read forge.db while the server writes; the busy
// timeout waits out short locks instead of failing the write at once.
export function configureConnection(sqlite: { exec(sql: string): unknown }) {
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
}

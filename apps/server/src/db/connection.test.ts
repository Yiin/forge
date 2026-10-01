import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { configureConnection } from './connection.js'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})

it('writes while another connection holds a read transaction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-connection-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'forge.db')
  const writer = new DatabaseSync(path)
  cleanup.push(() => writer.close())
  configureConnection(writer)
  writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
  writer.prepare('INSERT INTO t DEFAULT VALUES').run()

  const reader = new DatabaseSync(path)
  cleanup.push(() => reader.close())
  reader.exec('BEGIN')
  reader.prepare('SELECT * FROM t').all()

  writer.prepare('INSERT INTO t DEFAULT VALUES').run()
  expect(writer.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 2 })
  reader.exec('COMMIT')
  expect(writer.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
})

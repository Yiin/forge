#!/usr/bin/env node
import { access, copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

export function validateDatabasePath(databasePath: string, allowReal = false) {
  const resolved = resolve(databasePath)
  if (allowReal) return resolved
  const root = resolve(tmpdir())
  if (
    !resolved.startsWith(`${root}/`) ||
    resolved.split('/').pop() !== 'forge.db'
  )
    throw new Error(
      'Refusing database path. Use a tmpdir/forge.db path or --allow-real.',
    )
  return resolved
}

async function main() {
  const [, , operation, databaseArg, ...sqlParts] = process.argv
  if (!operation || !databaseArg || !['query', 'exec'].includes(operation))
    throw new Error(
      'Usage: forge-sqlite.ts <query|exec> <path> <sql> [--allow-real]',
    )
  const allowReal = sqlParts.includes('--allow-real')
  const sql = sqlParts
    .filter((part) => part !== '--allow-real')
    .join(' ')
    .trim()
  if (!sql) throw new Error('SQL is required.')
  const database = validateDatabasePath(databaseArg, allowReal)
  await access(database)
  if (operation === 'exec') {
    await mkdir(dirname(database), { recursive: true })
    await copyFile(database, `${database}.bak`)
  }
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('sqlite3', ['-json', database, sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let error = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (error += chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code) reject(new Error(error || `sqlite3 exited with ${code}`))
      else {
        process.stdout.write(output)
        resolvePromise()
      }
    })
  })
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })

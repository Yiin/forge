import { createServer, type Server } from 'node:net'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, test, vi } from 'vitest'
import { ownedListener } from './listener.js'

/** Which group members report as gone when their descriptors are scanned. */
let vanished: 'none' | 'every member' | 'other members' = 'none'
/** The code the kernel refuses a vanished member's descriptor directory with. */
let refusal: 'ENOENT' | 'EACCES' = 'ENOENT'
let refused = 0
/** Every directory the scan listed. */
const listed: string[] = []
/** Whether other members report as gone when their state is read, and how many did. */
let stateGone = false
let unread = 0
/** Whether other members refuse their descriptor links, and how many did. */
let linksDenied = false
let denied = 0
// A group member can exit between its state read and its descriptor scan. Real
// races are rare, so refuse the descriptor directory the same way the kernel does.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    opendir: (path: string, ...rest: never[]) => {
      listed.push(path)
      const member = /^\/proc\/(\d+)\/fd$/.exec(path)
      const gone =
        member &&
        (vanished === 'every member' ||
          (vanished === 'other members' && Number(member[1]) !== process.pid))
      if (gone) refused++
      return gone
        ? Promise.reject(
            Object.assign(
              new Error(
                refusal === 'EACCES'
                  ? `EACCES: permission denied, opendir '${path}'`
                  : `ENOENT: no such file or directory, opendir '${path}'`,
              ),
              { code: refusal, syscall: 'opendir', path },
            ),
          )
        : actual.opendir(path, ...rest)
    },
    readlink: (path: string, ...rest: never[]) => {
      const member = /^\/proc\/(\d+)\/fd\/\d+$/.exec(path)
      if (!linksDenied || !member || Number(member[1]) === process.pid)
        return actual.readlink(path, ...rest)
      denied++
      return Promise.reject(
        Object.assign(
          new Error(`EACCES: permission denied, readlink '${path}'`),
          { code: 'EACCES', syscall: 'readlink', path },
        ),
      )
    },
    open: (path: string, ...rest: never[]) => {
      const member = /^\/proc\/(\d+)\/stat$/.exec(path)
      if (!stateGone || !member || Number(member[1]) === process.pid)
        return actual.open(path, ...rest)
      unread++
      return Promise.reject(
        Object.assign(
          new Error(`ENOENT: no such file or directory, open '${path}'`),
          { code: 'ENOENT', syscall: 'open', path },
        ),
      )
    },
  }
})

const servers: Server[] = []
afterEach(async () => {
  vanished = 'none'
  refusal = 'ENOENT'
  refused = 0
  stateGone = false
  unread = 0
  linksDenied = false
  denied = 0
  listed.splice(0)
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
})

function listen() {
  const server = createServer()
  servers.push(server)
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'string' || !address)
        reject(new Error('Fixture listener has no port'))
      else resolve(address.port)
    })
  })
}

async function processGroup() {
  const stat = await readFile('/proc/self/stat', 'utf8')
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2])
}

test('accepts a listening socket held by an owned group member', async () => {
  const port = await listen()
  await expect(
    ownedListener(port, await processGroup(), performance.now() + 10_000),
  ).resolves.toBe(true)
  // The group scan starts from the process table, never from a cached listing.
  expect(listed[0]).toBe('/proc')
  expect(
    listed.every((path) => path === '/proc' || /^\/proc\/\d+\/fd$/.test(path)),
  ).toBe(true)
})

test('keeps scanning past a member that exits before its descriptor scan', async () => {
  const port = await listen()
  vanished = 'other members'
  await expect(
    ownedListener(port, await processGroup(), performance.now() + 10_000),
  ).resolves.toBe(true)
  // The runner and its worker share one group, so the scan really did skip one.
  expect(refused).toBeGreaterThan(0)
})

// An exiting member keeps its /proc entry but loses its access check, so the
// kernel refuses its descriptor directory with EACCES rather than ENOENT.
test('keeps scanning past a member whose descriptor directory refuses access', async () => {
  const port = await listen()
  vanished = 'other members'
  refusal = 'EACCES'
  await expect(
    ownedListener(port, await processGroup(), performance.now() + 10_000),
  ).resolves.toBe(true)
  expect(refused).toBeGreaterThan(0)
})

test('keeps scanning past a member that exits before its state read', async () => {
  const port = await listen()
  stateGone = true
  await expect(
    ownedListener(port, await processGroup(), performance.now() + 10_000),
  ).resolves.toBe(true)
  // Every other process on the host reported gone, so the scan really skipped.
  expect(unread).toBeGreaterThan(0)
})

test('keeps scanning past a descriptor this user cannot read', async () => {
  const port = await listen()
  linksDenied = true
  await expect(
    ownedListener(port, await processGroup(), performance.now() + 10_000),
  ).resolves.toBe(true)
  // Another user's process can share the scan without sharing its descriptors.
  expect(denied).toBeGreaterThan(0)
})

test('reports a foreign listener when every owned member refuses access', async () => {
  const port = await listen()
  vanished = 'every member'
  refusal = 'EACCES'
  await expect(
    ownedListener(port, await processGroup(), performance.now() + 10_000),
  ).rejects.toMatchObject({ code: 'kimi_foreign_listener' })
})

test('reports a foreign listener when every owned member exits mid-scan', async () => {
  const port = await listen()
  vanished = 'every member'
  await expect(
    ownedListener(port, await processGroup(), performance.now() + 10_000),
  ).rejects.toMatchObject({ code: 'kimi_foreign_listener' })
})

test('reports no listener before the port is bound', async () => {
  const port = await listen()
  await new Promise<void>((resolve) =>
    servers.splice(0)[0]!.close(() => resolve()),
  )
  await expect(
    ownedListener(port, await processGroup(), performance.now() + 10_000),
  ).resolves.toBe(false)
})

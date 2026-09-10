import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { fixture, barrier } from './fixtures.js'
import { hash } from './paths.js'
import { WORKSPACE_LIMITS, readBounded } from './files.js'
import { createProject, createSession } from '../db/queries.js'
import { runGit } from '../git/exec.js'

const temporaryFiles = async (root: string) =>
  (await readdir(root)).filter((name) => name.startsWith('.forge-save-'))
describe('workspace text and existing-file saves', () => {
  it.each([
    ['utf8', Buffer.from('héllo\n'), 'utf8', 'lf', null, 'héllo\n'],
    ['bom', Buffer.from('\ufeffhello\r\n'), 'utf8Bom', 'crlf', null, 'hello\n'],
    ['none', Buffer.from('one'), 'utf8', 'none', null, 'one'],
    ['empty', Buffer.alloc(0), 'utf8', 'none', null, ''],
    [
      'mixed',
      Buffer.from('one\r\ntwo\n'),
      'utf8',
      'mixed',
      'mixedLineEndings',
      'one\ntwo\n',
    ],
    [
      'cr',
      Buffer.from('one\rtwo'),
      'utf8',
      'mixed',
      'mixedLineEndings',
      'one\rtwo',
    ],
    ['binary', Buffer.from([0, 1]), 'binary', null, 'binary', null],
    [
      'invalid',
      Buffer.from([0xff]),
      'unsupported',
      null,
      'unsupportedEncoding',
      null,
    ],
  ])(
    'reads %s bytes without losing source metadata',
    async (_name, bytes, encoding, lineEnding, readOnlyReason, text) => {
      const f = await fixture()
      await writeFile(join(f.root, 'file.txt'), bytes as Buffer)
      const { file } = await f.snapshot()
      expect(file).toMatchObject({
        encoding,
        lineEnding,
        readOnlyReason,
        text,
        contentHash: hash(bytes as Buffer),
        sizeBytes: (bytes as Buffer).length,
        truncated: false,
      })
    },
  )
  it.each([
    WORKSPACE_LIMITS.editBytes,
    WORKSPACE_LIMITS.editBytes + 1,
    WORKSPACE_LIMITS.previewBytes,
    WORKSPACE_LIMITS.previewBytes + 1,
  ])('bounds %s byte previews', async (size) => {
    const f = await fixture()
    await writeFile(join(f.root, 'file.txt'), Buffer.alloc(size, 97))
    const { file } = await f.snapshot()
    expect(file.readOnlyReason).toBe(
      size > WORKSPACE_LIMITS.editBytes ? 'tooLarge' : null,
    )
    expect(file.truncated).toBe(size > WORKSPACE_LIMITS.previewBytes)
    expect(file.text?.length ?? 0).toBe(
      size > WORKSPACE_LIMITS.previewBytes ? 0 : size,
    )
  })
  it('caps a growing descriptor read at limit plus one', async () => {
    const f = await fixture()
    const path = join(f.root, 'file.txt')
    const handle = await open(path, 'r')
    try {
      await writeFile(path, Buffer.alloc(2048, 97))
      expect((await readBounded(handle, 32)).length).toBe(33)
    } finally {
      await handle.close()
    }
  })
  it.each(['\ufeffone\r\n', 'one\n', 'one'])(
    'saves with original form and permissions: %j',
    async (original) => {
      const f = await fixture()
      const path = join(f.root, 'file.txt')
      await writeFile(path, original)
      await chmod(path, 0o640)
      const input = await f.input('two\n')
      const response = await f.save(input)
      expect(response.status).toBe(200)
      expect(await readFile(path, 'utf8')).toBe(
        original.startsWith('\ufeff') ? '\ufefftwo\r\n' : 'two\n',
      )
      expect((await lstat(path)).mode & 0o777).toBe(0o640)
      expect((await response.json()).file.fileRevision).not.toBe(
        input.expectedFileRevision,
      )
      expect(await temporaryFiles(f.root)).toEqual([])
    },
  )
  it('keeps files without newlines and rejects CR or NUL input', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'file.txt'), 'one')
    expect((await f.save(await f.input('two'))).status).toBe(200)
    expect(await readFile(join(f.root, 'file.txt'), 'utf8')).toBe('two')
    for (const text of ['a\rb', 'a\0b'])
      expect((await f.save(await f.input(text))).status).toBe(400)
  })
  it('rejects read-only mode even when the parent permits rename', async () => {
    const f = await fixture()
    await chmod(join(f.root, 'file.txt'), 0o444)
    expect((await f.snapshot()).file.readOnlyReason).toBe('permissionDenied')
    expect((await f.save(await f.input('new'))).status).toBe(403)
    expect(await readFile(join(f.root, 'file.txt'), 'utf8')).toBe('original\n')
  })
  it.each(['different', 'original\n'])(
    'allows exactly one client to save one file revision: %j',
    async (text) => {
      const f = await fixture()
      const input = await f.input(text)
      const responses = await Promise.all([f.save(input), f.save(input)])
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
      expect(f.service.diagnostics.fileQueues).toBe(0)
    },
  )
  it('serializes shared-session and nested project-alias saves for the same physical path', async () => {
    const f = await fixture(true)
    await mkdir(join(f.root, 'nested'))
    await writeFile(join(f.root, 'nested', 'shared.txt'), 'shared')
    const alias = createProject(f.db, {
      name: 'Alias',
      path: join(f.root, 'nested'),
    })
    const second = createSession(f.db, {
      projectId: alias.id,
      cwd: alias.path,
      harness: 'unavailable',
      title: 'Alias',
    })
    const a = await f.input('a', 'nested/shared.txt'),
      b = await f.input('b', 'shared.txt', {
        kind: 'session',
        sessionId: second.id,
      })
    expect(
      (await Promise.all([f.save(a), f.save(b)])).map((r) => r.status).sort(),
    ).toEqual([200, 409])
    const third = createSession(f.db, {
      projectId: f.project.id,
      cwd: f.root,
      harness: 'other',
      title: 'Other',
    })
    const c = await f.input('c'),
      d = await f.input('d', 'file.txt', {
        kind: 'session',
        sessionId: third.id,
      })
    expect(
      (await Promise.all([f.save(c), f.save(d)])).map((r) => r.status).sort(),
    ).toEqual([200, 409])
  })
  it.each(['replace', 'change', 'delete', 'parent'])(
    'rejects %s during staged save without writing outside the target',
    async (change) => {
      const gate = barrier()
      const f = await fixture(false, { staged: gate.hook })
      await mkdir(join(f.root, 'nested'))
      await writeFile(join(f.root, 'nested/file.txt'), 'inside')
      const outside = join(f.dir, 'outside')
      await mkdir(outside)
      await writeFile(join(outside, 'file.txt'), 'outside')
      const input = await f.input('submitted', 'nested/file.txt')
      const saving = f.save(input)
      await gate.reached
      const path = join(f.root, 'nested/file.txt')
      if (change === 'replace') {
        await rename(path, `${path}.old`)
        await writeFile(path, 'inside')
      }
      if (change === 'change') await writeFile(path, 'external')
      if (change === 'delete') await rm(path)
      if (change === 'parent') {
        await rename(join(f.root, 'nested'), join(f.root, 'moved'))
        await symlink(outside, join(f.root, 'nested'))
      }
      gate.release()
      const response = await saving
      expect(response.status).toBe(409)
      expect((await response.json()).reason).toMatch(/replaced|changed|deleted/)
      expect(await readFile(join(outside, 'file.txt'), 'utf8')).toBe('outside')
      expect(
        await temporaryFiles(
          join(f.root, change === 'parent' ? 'moved' : 'nested'),
        ),
      ).toEqual([])
    },
  )
  it.each(['read', 'save', 'media', 'list', 'search'])(
    'rejects an ancestor symlink swap during initial %s traversal',
    async (operation) => {
      const gate = barrier()
      let enabled = false
      const f = await fixture(false, {
        beforeDirectoryOpen: async (path) => {
          if (enabled && path === 'a') await gate.hook()
        },
      })
      await mkdir(join(f.root, 'a'))
      await mkdir(join(f.root, 'a/b'))
      await writeFile(join(f.root, 'a/b/file.txt'), 'inside')
      await mkdir(join(f.dir, 'outside'))
      await mkdir(join(f.dir, 'outside/b'))
      await writeFile(join(f.dir, 'outside/b/file.txt'), 'secret')
      const input = await f.input('submitted', 'a/b/file.txt')
      enabled = true
      const request =
        operation === 'save'
          ? f.save(input)
          : f.app.request(
              f.url(
                operation === 'read'
                  ? 'file'
                  : operation === 'list'
                    ? 'files'
                    : operation,
                operation === 'search'
                  ? { query: 'file' }
                  : { path: operation === 'list' ? 'a/b' : 'a/b/file.txt' },
              ),
            )
      await gate.reached
      await rename(join(f.root, 'a'), join(f.root, 'moved'))
      await symlink(join(f.dir, 'outside'), join(f.root, 'a'))
      gate.release()
      const response = await request
      const body = await response.text()
      expect(body).not.toContain('secret')
      if (operation === 'search') {
        expect(response.status).toBe(200)
        expect(JSON.parse(body).partialReasons).toContain('unreadable')
      } else expect([403, 409]).toContain(response.status)
      expect(await readFile(join(f.dir, 'outside/b/file.txt'), 'utf8')).toBe(
        'secret',
      )
    },
  )
  it.each(['partial', 'flush', 'rename', 'published'])(
    'cleans temporary files after %s failure and reports publication honestly',
    async (failure) => {
      const fault = async () => {
        throw new Error('Injected failure')
      }
      const f = await fixture(
        false,
        failure === 'partial'
          ? {
              writeTemporary: async (write) => {
                await write(2)
                await fault()
              },
            }
          : failure === 'flush'
            ? { flushTemporary: fault }
            : failure === 'rename'
              ? { renameTemporary: fault }
              : { afterPublish: fault },
      )
      const response = await f.save(await f.input('published\n'))
      expect(response.status).toBe(503)
      expect(await readFile(join(f.root, 'file.txt'), 'utf8')).toBe(
        failure === 'published' ? 'published\n' : 'original\n',
      )
      expect(await temporaryFiles(f.root)).toEqual([])
      const body = await response.json()
      expect(body.error).toBe(
        failure === 'published' ? 'publication_uncertain' : 'unavailable',
      )
      if (failure === 'published')
        expect(body.publicationMayHaveHappened).toBe(true)
    },
  )
  it('aborts staged writes on shutdown and keeps the index and unrelated bytes', async () => {
    const gate = barrier()
    const f = await fixture(true, { staged: gate.hook })
    await writeFile(join(f.root, 'unrelated'), 'staged')
    await runGit(f.root, ['add', 'unrelated'])
    const index = await readFile(join(f.root, '.git/index'))
    const saving = f.save(await f.input('new'))
    await gate.reached
    const closing = f.service.close()
    gate.release()
    expect((await saving).status).toBe(503)
    await closing
    expect(await readFile(join(f.root, '.git/index'))).toEqual(index)
    expect(await readFile(join(f.root, 'unrelated'), 'utf8')).toBe('staged')
    expect(await readFile(join(f.root, 'file.txt'), 'utf8')).toBe('original\n')
    expect(await temporaryFiles(f.root)).toEqual([])
    expect(f.service.diagnostics.operations).toBe(0)
  })
})

describe('workspace access validation', () => {
  it.each([
    '../file.txt',
    '/etc/passwd',
    'a/../file.txt',
    'a/./file.txt',
    '.git/config',
    'x/.GiT/config',
    'a\\b',
    'a:b',
    'a\0b',
    'a//b',
    '.forge-save-hidden',
  ])('rejects %j', async (path) => {
    const f = await fixture()
    const response = await f.app.request(f.url('file', { path }))
    expect([400, 403]).toContain(response.status)
  })
  it('rejects ambiguous selectors, raw roots, duplicate keys, and project writes', async () => {
    const f = await fixture()
    for (const path of [
      f.url('target', { projectId: f.project.id }),
      f.url('target', { cwd: f.root }),
      `${f.url('target')}&kind=session`,
    ])
      expect((await f.app.request(path)).status).toBe(400)
    const response = await f.save({
      ...(await f.input('bad')),
      target: { kind: 'project', projectId: f.project.id },
    } as never)
    expect(response.status).toBe(400)
    expect(
      (await f.app.request(f.url('file', { path: '%2e%2e/file.txt' }))).status,
    ).toBe(404)
    expect(
      (await f.app.request(`${f.url('file')}&path=..%2Ffile.txt`)).status,
    ).toBe(400)
  })
  it('rejects symlinks, dangling links, FIFOs, and sockets before reading bytes', async () => {
    const f = await fixture()
    await symlink(join(f.root, 'file.txt'), join(f.root, 'link'))
    await symlink(join(f.root, 'missing'), join(f.root, 'dangling'))
    await promisify(execFile)('mkfifo', [join(f.root, 'fifo')])
    const socket = createServer()
    await new Promise<void>((resolve) =>
      socket.listen(join(f.root, 'socket'), resolve),
    )
    try {
      for (const path of ['link', 'dangling', 'fifo', 'socket'])
        expect((await f.app.request(f.url('file', { path }))).status).toBe(403)
      const listing = await (await f.app.request(f.url('files'))).json()
      expect(
        listing.entries.find(
          (entry: { path: string }) => entry.path === 'link',
        ),
      ).toMatchObject({ type: 'symlink', sizeBytes: null, modifiedAt: null })
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()))
    }
  })
  it('rejects oversized JSON before parsing and oversized encoded save output', async () => {
    const f = await fixture()
    const response = await f.app.request('/api/workspace/file', {
      method: 'PUT',
      body: ' '.repeat(WORKSPACE_LIMITS.requestBytes + 1),
    })
    expect(response.status).toBe(413)
    expect(
      (
        await f.app.request('/api/workspace/file', {
          method: 'PUT',
          body: '{broken',
        })
      ).status,
    ).toBe(400)
    await writeFile(join(f.root, 'file.txt'), '\ufeffa\r\n')
    const save = await f.save(await f.input('\n'.repeat(600_000)))
    expect(save.status).toBe(413)
  })
})

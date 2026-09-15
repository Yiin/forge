import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  writeFile,
  lstat,
  readdir,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const exec = promisify(execFile)
const archive = resolve(process.argv[2] ?? ''),
  log = process.argv[3],
  scope = process.argv[4] ?? 'full'
if (
  !log ||
  !archive.endsWith('.tar.gz') ||
  !['full', 'store-contract'].includes(scope)
)
  throw new Error(
    'Pass the release archive, a new receipt path, and an optional store-contract scope',
  )
const image =
  'sha256:add8a79eb869161ea59bfed363e80b11104315eea2afc2a9cc782c88a05757d4'
const node = '/home/yiin/.vite-plus/js_runtime/node/24.21.0/bin/node',
  name = `forge-cursor-runtime-${randomUUID()}`
const data = await mkdtemp(join(tmpdir(), 'forge-cursor-runtime-')),
  extracted = await mkdtemp(join(tmpdir(), 'forge-cursor-extracted-'))
const result = { scope, image, archive, name, passed: false }
async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
let child, timer
try {
  await mkdir(join(data, 'owned'), { mode: 0o700 })
  const info = await lstat(archive)
  if (!info.isFile() || info.size > 2 * 1024 * 1024 * 1024)
    throw new Error('Release archive exceeds its diagnostic bound')
  const { stdout: listing } = await exec('tar', ['-tzf', archive], {
    timeout: 15000,
    maxBuffer: 2 * 1024 * 1024,
  })
  const entries = listing.trim().split('\n')
  if (
    entries.length > 20000 ||
    entries.some(
      (path) =>
        !path.startsWith('forge-linux-x64/') ||
        path.split('/').includes('..') ||
        path.includes('\0'),
    )
  )
    throw new Error('Release archive path is invalid')
  await exec(
    'tar',
    ['-xzf', archive, '--no-same-owner', '--same-permissions', '-C', extracted],
    {
      timeout: 15000,
      maxBuffer: 4096,
    },
  )
  const pending = [extracted]
  let count = 0,
    bytes = 0
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 20000 || entry.isSymbolicLink())
        throw new Error('Extracted release contains unsupported entries')
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) {
        bytes += (await lstat(path)).size
        if (bytes > 2 * 1024 * 1024 * 1024)
          throw new Error('Extracted release exceeds its diagnostic bound')
      } else throw new Error('Extracted release contains a non-file entry')
    }
  }
  const relative = 'forge-linux-x64/apps/server/src/cursor-sidecar',
    artifact = join(extracted, relative)
  const manifest = JSON.parse(
    await readFile(join(artifact, 'manifest.json'), 'utf8'),
  )
  for (const entry of manifest.files) {
    const path = join(artifact, entry.path),
      info = await lstat(path)
    if (
      !info.isFile() ||
      info.size !== entry.bytes ||
      (info.mode & 511) !== entry.mode ||
      (await digest(path)) !== entry.sha256
    )
      throw new Error(
        `Extracted sidecar differs from its manifest: ${entry.path}`,
      )
  }
  Object.assign(result, {
    archiveSha256: await digest(archive),
    nodeSha256: await digest(node),
    artifactManifestSha256: await digest(join(artifact, 'manifest.json')),
    entrySha256: await digest(join(artifact, 'sidecar.mjs')),
    guardianSha256: await digest(join(artifact, 'guardian.mjs')),
    extractedEntries: count,
    extractedBytes: bytes,
    outside: await readlink('/proc/self/ns/net'),
  })
  const args = [
    'run',
    '--pull=never',
    '--rm',
    '--name',
    name,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    '1g',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=134217728',
    '--workdir',
    '/probe-data/owned',
    '--entrypoint',
    '/probe-loader',
  ]
  for (const [source, target, readonly] of [
    [node, '/probe-node', true],
    ['/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', '/probe-loader', true],
    ['/lib/x86_64-linux-gnu', '/probe-libraries', true],
    [extracted, '/probe-release', true],
    [data, '/probe-data', false],
  ])
    args.push(
      '--mount',
      `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`,
    )
  args.push(
    image,
    '--library-path',
    '/probe-libraries',
    '/probe-node',
    `/probe-release/${relative}/sidecar.mjs`,
    '--runtime-probe',
    result.outside,
    '/probe-data/owned',
    scope,
  )
  await exec('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {
    timeout: 5000,
    maxBuffer: 4096,
  })
  child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = [],
    stderr = []
  let outputBytes = 0
  for (const [stream, chunks] of [
    [child.stdout, stdout],
    [child.stderr, stderr],
  ])
    stream.on('data', (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > 65536) child.kill('SIGKILL')
      else chunks.push(chunk)
    })
  timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  result.exitCode = await new Promise((done, reject) => {
    child.once('error', reject)
    child.once('close', done)
  })
  result.stdout = Buffer.concat(stdout).toString('utf8')
  result.stderr = Buffer.concat(stderr).toString('utf8')
  result.passed = result.exitCode === 0
} catch (error) {
  result.error = error.message.slice(0, 4096)
} finally {
  clearTimeout(timer)
  await exec('docker', ['container', 'rm', '--force', name], {
    timeout: 10000,
    maxBuffer: 4096,
  }).catch(() => {})
  result.containerRemoved = await exec(
    'docker',
    ['container', 'inspect', name, '--format', '{{.Id}}'],
    { timeout: 5000, maxBuffer: 4096 },
  ).then(
    () => false,
    () => true,
  )
  await rm(data, { recursive: true, force: true })
  await rm(extracted, { recursive: true, force: true })
  result.dataRemoved = true
  result.extractionRemoved = true
  await writeFile(log, JSON.stringify(result, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })
}
console.log(
  JSON.stringify({
    scope,
    passed: result.passed,
    containerRemoved: result.containerRemoved,
    receipt: log,
  }),
)
process.exitCode = result.passed && result.containerRemoved ? 0 : 1

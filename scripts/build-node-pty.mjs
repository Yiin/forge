import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'apps/server/package.json'))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const record = (path) => ({
  path,
  sha256: hash(readFileSync(path)),
  bytes: statSync(path).size,
  mode: (statSync(path).mode & 0o777).toString(8).padStart(4, '0'),
})
function files(path) {
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const next = join(path, entry.name)
      return entry.isDirectory()
        ? files(next)
        : entry.isFile()
          ? [record(next)]
          : []
    })
}
function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120000,
    ...options,
  })
  if (result.error || result.status !== 0)
    throw new Error(`${file} failed: ${result.error ?? result.stderr}`)
  return result
}
if (
  process.platform !== 'linux' ||
  process.arch !== 'x64' ||
  process.versions.node !== '24.21.0' ||
  process.versions.bun
)
  throw new Error('native:build requires actual Node 24.21.0 on linux-x64')
const source = realpathSync(
  process.argv[3] ?? dirname(require.resolve('node-pty/package.json')),
)
const testFaults = process.argv[4] === '--test-faults'
if (process.argv[4] && !testFaults)
  throw new Error('Unknown native build option')
if (!source.startsWith(`${root}/node_modules/`))
  throw new Error('node-pty must resolve inside the checkout')
// Bun 1.3.9 still hardlinks patched package files with --backend=copyfile.
// Replace checkout entries with identical owned copies. Never write a shared inode.
for (const input of files(source)) {
  if (statSync(input.path).nlink === 1) continue
  const isolated = `${input.path}.forge-copy-${process.pid}`
  cpSync(input.path, isolated, { errorOnExist: true, force: false })
  renameSync(isolated, input.path)
}
const addon = realpathSync(
  dirname(
    createRequire(require.resolve('node-pty/package.json')).resolve(
      'node-addon-api/package.json',
    ),
  ),
)
const gyp = realpathSync(require.resolve('node-gyp/bin/node-gyp.js'))
if (
  JSON.parse(readFileSync(resolve(dirname(gyp), '../package.json'))).version !==
  '11.4.2'
)
  throw new Error('node-gyp 11.4.2 is required')
if (JSON.parse(readFileSync(join(addon, 'package.json'))).version !== '7.1.1')
  throw new Error('node-addon-api 7.1.1 is required')
const headers = realpathSync(
  process.env.FORGE_NODE_HEADERS ?? resolve(dirname(process.execPath), '..'),
)
const version = readFileSync(
  join(headers, 'include/node/node_version.h'),
  'utf8',
)
if (
  !version.includes('#define NODE_MAJOR_VERSION 24') ||
  !version.includes('#define NODE_MINOR_VERSION 21') ||
  !version.includes('#define NODE_PATCH_VERSION 0')
)
  throw new Error(
    'Matching local Node 24.21.0 headers are required; native:build never downloads headers',
  )
const scratch = resolve(
  process.argv[2] ?? join(root, '.native-build', `${process.pid}`),
)
if (existsSync(scratch))
  throw new Error(`Build scratch already exists: ${scratch}`)
mkdirSync(scratch, { recursive: true })
const env = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: join(scratch, 'home'),
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
  SOURCE_DATE_EPOCH: '1767225600',
  CC: '/usr/bin/gcc',
  CXX: '/usr/bin/g++',
  PYTHON: '/usr/bin/python3',
  CFLAGS: `-MD -ffile-prefix-map=${scratch}=/forge-native -fdebug-prefix-map=${scratch}=/forge-native`,
  CXXFLAGS: `${testFaults ? '-DFORGE_OWNED_TESTING=1 ' : ''}-MD -ffile-prefix-map=${scratch}=/forge-native -fdebug-prefix-map=${scratch}=/forge-native`,
}
mkdirSync(env.HOME)
const input = [
  record(process.execPath),
  record(join(root, '.node-version')),
  record(join(root, 'scripts/native-build.json')),
  record(gyp),
  record(join(source, 'package.json')),
  record(join(source, 'binding.gyp')),
  ...files(join(source, 'src')),
  ...files(addon),
  ...files(join(headers, 'include/node')),
]
const packages = new Set()
function packageInputs(manifestPath) {
  const directory = realpathSync(dirname(manifestPath))
  if (packages.has(directory)) return
  packages.add(directory)
  input.push(...files(directory))
  const local = createRequire(join(directory, 'package.json'))
  const manifest = JSON.parse(
    readFileSync(join(directory, 'package.json'), 'utf8'),
  )
  for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
    let dependency
    try {
      dependency = local.resolve(`${name}/package.json`)
    } catch {
      let candidate = dirname(local.resolve(name))
      while (!existsSync(join(candidate, 'package.json'))) {
        const parent = dirname(candidate)
        if (parent === candidate)
          throw new Error(`Cannot inventory build dependency ${name}`)
        candidate = parent
      }
      dependency = join(candidate, 'package.json')
    }
    packageInputs(dependency)
  }
}
packageInputs(resolve(dirname(gyp), '../package.json'))
const builds = []
for (const name of ['first', 'second']) {
  const work = join(scratch, name)
  mkdirSync(work)
  for (const path of ['package.json', 'binding.gyp', 'src'])
    cpSync(join(source, path), join(work, path), {
      recursive: true,
      force: false,
      errorOnExist: true,
    })
  mkdirSync(join(work, 'node_modules'))
  cpSync(addon, join(work, 'node_modules/node-addon-api'), {
    recursive: true,
    errorOnExist: true,
  })
  const args = [gyp, 'rebuild', '--directory', work, '--nodedir', headers]
  const buildEnv = {
    ...env,
    CFLAGS: `${env.CFLAGS} -ffile-prefix-map=${work}=/forge-source -fdebug-prefix-map=${work}=/forge-source`,
    CXXFLAGS: `${env.CXXFLAGS} -ffile-prefix-map=${work}=/forge-source -fdebug-prefix-map=${work}=/forge-source`,
  }
  const result = run(process.execPath, args, { cwd: root, env: buildEnv })
  writeFileSync(join(scratch, `${name}.log`), result.stdout + result.stderr)
  builds.push({
    command: [process.execPath, ...args],
    environment: buildEnv,
    output: record(join(work, 'build/Release/pty.node')),
  })
  const dependencyFile = join(
    work,
    'build/Release/.deps/Release/obj.target/pty/src/unix/pty.o.d',
  )
  const dependencies = readFileSync(dependencyFile, 'utf8')
    .replaceAll('\\\n', '')
    .split('\n')[1]
  const names =
    dependencies
      .slice(dependencies.indexOf(':') + 1)
      .match(/(?:\\.|[^\s])+/g) ?? []
  for (const name of names)
    input.push(record(resolve(work, 'build', name.replace(/\\(.)/g, '$1'))))
}
if (builds[0].output.sha256 !== builds[1].output.sha256)
  throw new Error('Native build bytes differ; preserve both build directories')
// Fault binaries remain in their test scratch. Never publish them to node-pty.
const outputDirectory = testFaults
  ? join(scratch, 'test-only')
  : join(source, 'build/Release')
mkdirSync(outputDirectory, { recursive: true })
const temporary = join(outputDirectory, `pty.node.${process.pid}.new`)
cpSync(builds[0].output.path, temporary, { errorOnExist: true, force: false })
renameSync(temporary, join(outputDirectory, 'pty.node'))
const manifest = {
  apiVersion: 1,
  testFaults,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  headers,
  input,
  builds,
  toolchain: [
    '/usr/bin/gcc',
    '/usr/bin/g++',
    '/usr/bin/ld',
    '/usr/bin/make',
    '/usr/bin/python3',
  ].map(record),
  compiler: run('/usr/bin/g++', ['--version']).stdout,
  libc: run('/usr/bin/ldd', ['--version']).stdout,
  output: record(join(outputDirectory, 'pty.node')),
}
writeFileSync(
  join(scratch, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
)
writeFileSync(
  join(outputDirectory, 'forge-owned-build.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
)
console.log(
  JSON.stringify({
    manifest: join(scratch, 'manifest.json'),
    sha256: manifest.output.sha256,
    reproducible: true,
  }),
)

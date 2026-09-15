import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
const root = dirname(fileURLToPath(import.meta.url))
if (!/^\/tmp\/forge-cursor-manager-[^/]+$/.test(root))
  throw new Error('Unowned fixture root')
const secret = 'synthetic-manager-secret'
const seeded = {
  NODE_OPTIONS: `--require=${join(root, 'injection.cjs')}`,
  LD_PRELOAD: '/nonexistent/fixture-loader.so',
  FORGE_FAKE_MANAGER_SECRET: secret,
  PATH: '/usr/bin:/bin',
}
const args = process.argv.slice(3)
if (process.argv[2] === 'control') {
  if (args.includes('show-environment'))
    process.stdout.write(
      Object.entries(seeded)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
    )
  else if (args.includes('show')) {
    const pid = Number(readFileSync(join(root, 'service-pid'), 'utf8')),
      cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
        .trim()
        .split('\n')
        .find((line) => line.startsWith('0::'))!
        .slice(3),
      unit = args[args.indexOf('show') + 1]
    process.stdout.write(
      Object.entries({
        Id: unit,
        InvocationID: 'a'.repeat(32),
        ControlGroup: cgroup,
        MainPID: pid,
        ActiveState: 'active',
        SubState: 'running',
        Job: '0',
        KillMode: 'control-group',
        SendSIGKILL: 'yes',
        ExitType: 'main',
        Restart: 'no',
        TasksMax: '256',
        RuntimeMaxUSec: '2h',
      })
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
    )
  } else throw new Error('Unexpected fixture control verb')
} else if (process.argv[2] === 'run') {
  const unset = args
      .find((arg) => arg.startsWith('--property=UnsetEnvironment='))!
      .slice('--property=UnsetEnvironment='.length)
      .split(' '),
    command = args.slice(args.indexOf('--') + 1),
    environment: NodeJS.ProcessEnv = { ...seeded }
  for (const key of unset) delete environment[key]
  if (command[0] !== process.execPath || !command.includes('--managed'))
    throw new Error('Unexpected fixture service')
  const child = spawn(command[0], command.slice(1), {
    cwd: root,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  writeFileSync(join(root, 'service-pid'), String(child.pid), { mode: 0o600 })
  writeFileSync(
    join(root, 'observed.json'),
    JSON.stringify({
      unset,
      secretInArguments: args.some((arg) => arg.includes(secret)),
      secretBeforeGrant: Object.values(environment).some((value) =>
        value?.includes(secret),
      ),
      preloadBeforeGrant:
        Object.hasOwn(environment, 'NODE_OPTIONS') ||
        Object.hasOwn(environment, 'LD_PRELOAD'),
    }),
    { mode: 0o600 },
  )
  process.stdin.pipe(child.stdin)
  child.stdout.pipe(process.stdout)
  let bytes = 0
  child.stderr.on('data', (chunk) => {
    bytes += chunk.length
    if (bytes > 4096) child.kill('SIGKILL')
  })
  child.once('close', () => process.exit())
} else throw new Error('Unexpected fixture mode')

import { open } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const file = await open(process.argv[2], 'r+')
try {
  const utility = spawn('/usr/bin/flock', ['--nonblock', '3'], {
    stdio: ['ignore', 'ignore', 'ignore', file.fd],
  })
  await new Promise((resolve, reject) => {
    utility.once('error', reject)
    utility.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('Registry fixture lock busy')),
    )
  })
  process.stdout.write('locked\n')
  process.stdin.resume()
  await new Promise((resolve) => process.stdin.once('end', resolve))
} finally {
  await file.close()
}

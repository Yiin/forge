import { createApp } from '../src/index.js'
import { RequestGuard } from '../src/request-guard.js'

export function createTestApp(...args: Parameters<typeof createApp>) {
  args[11] = new RequestGuard({
    mode: 'explicit',
    allowedOrigins: ['http://localhost'],
    allowedHostAuthorities: ['localhost'],
  })
  return createApp(...args)
}

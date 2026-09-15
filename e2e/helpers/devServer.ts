/** The launcher keeps the assigned Vite port bound throughout the browser run. */
export function devServerPort(): number {
  const value = process.env.FORGE_E2E_PORT
  const port = Number(value)
  if (
    !value ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error(
      'Run browser tests with bun run e2e to assign an owned server port',
    )
  return port
}

export function devServerOrigin(): string {
  return `http://127.0.0.1:${devServerPort()}`
}

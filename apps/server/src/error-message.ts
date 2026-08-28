// ACP SDK rejections are raw JSON-RPC error objects, not Error instances.
// String(error) turns those into "[object Object]"; serialize them instead.
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

export const SEARCH_DEBOUNCE_MS = 150
export function shouldSearch(query: string) {
  return query.trim().length > 0
}
export function searchDue(query: string, changedAt: number, now: number) {
  return shouldSearch(query) && now - changedAt >= SEARCH_DEBOUNCE_MS
}
export function searchUrl(query: string) {
  return `/search?q=${encodeURIComponent(query)}`
}
export function messageHitUrl(sessionId: string, seq: number) {
  return `/s/${encodeURIComponent(sessionId)}?m=${encodeURIComponent(String(seq))}`
}
export function runHitUrl(runId: string) {
  return `/runs/${encodeURIComponent(runId)}`
}

const idToken = /\b[a-z0-9]+-[a-z0-9]{2,4}(?:\.[0-9]+)?\b/gi

export function sanitizeTitle(value: string, fallback = 'New session') {
  const clean = value
    .replace(idToken, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s'.,!?()/-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return fallback
  return clean.split(' ').slice(0, 8).join(' ').slice(0, 96).trim() || fallback
}

export function titleFromPrompt(prompt: string) {
  const words = prompt
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[^\p{L}\p{N}\s'.,!?()/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitizeTitle(words, 'New session')
}

export function isDefaultTitle(title: string) {
  return title.trim().toLowerCase() === 'new session'
}

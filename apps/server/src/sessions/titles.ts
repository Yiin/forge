const idToken = /\b[a-z0-9]+-[a-z0-9]{2,4}(?:\.[0-9]+)?\b/gi

export function sanitizeTitle(value: string, fallback = 'New session') {
  return cleanTitle(value.replace(idToken, ''), fallback)
}

function cleanTitle(value: string, fallback: string) {
  const clean = value
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

export type TitleMessage = { role: 'user' | 'assistant'; text: string }

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text

/**
 * Builds the prompt a small model answers with a session title. It sees the
 * opening request and the latest exchange, so the title follows the topic as
 * the conversation moves.
 */
export function titleRequest(messages: TitleMessage[], current: string) {
  const users = messages.filter((message) => message.role === 'user')
  const first = users[0]?.text ?? ''
  const latest = users.at(-1)?.text ?? ''
  const reply =
    messages.filter((message) => message.role === 'assistant').at(-1)?.text ??
    ''
  return [
    'Write a title for this coding conversation.',
    'Rules: 2 to 6 words. Sentence case. Name the topic, not the steps.',
    'No quotes, no ending punctuation, no issue ids. Reply with the title only.',
    `Keep the current title if it still fits: ${current}`,
    '',
    `Opening request:\n${clip(first, 1500)}`,
    ...(users.length > 1 ? ['', `Latest request:\n${clip(latest, 1500)}`] : []),
    ...(reply ? ['', `Latest reply:\n${clip(reply, 1500)}`] : []),
  ].join('\n')
}

/** The model's title, or null when the reply has none. */
export function titleFromReply(reply: string) {
  const line = reply
    .split('\n')
    .map((value) => value.trim().replace(/^["'`*#\s]+|["'`*.\s]+$/g, ''))
    .find(Boolean)
  if (!line) return null
  return cleanTitle(line, '') || null
}

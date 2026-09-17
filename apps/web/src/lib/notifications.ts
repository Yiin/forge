import type { ServerEvent } from '@forge/protocol/events'
import { readNotificationPreferences } from './settings-preferences'

export function notifySessionEvent(event: ServerEvent, connectedAt: number) {
  if (
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  )
    return
  const createdAt = Date.parse(event.msg.createdAt)
  if (!Number.isFinite(createdAt) || createdAt < connectedAt) return
  const preferences = readNotificationPreferences()
  const content = event.msg.content
  const completion = content.type === 'turn_end' && preferences.completion
  const request =
    content.type === 'ask_user_question' &&
    preferences.requests &&
    (content.requestStatus === undefined || content.requestStatus === 'pending')
  if (!completion && !request) return
  try {
    new Notification(
      completion ? 'Forge turn completed' : 'Forge needs your answer',
      {
        tag: `forge:${event.sessionId}:${event.msg.itemId}:${content.type}`,
      },
    )
  } catch {
    // Browser policy can refuse delivery after permission was checked.
  }
}

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { notifySessionEvent } from './notifications'
import { writeNotificationPreferences } from './settings-preferences'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})
const event = (type: string, status?: string) =>
  ({
    seq: 1,
    sessionId: 'session',
    msg: {
      itemId: 'item',
      createdAt: new Date(1000).toISOString(),
      content: { type, requestStatus: status },
    },
  }) as any

it('delivers only enabled live completion and pending request notifications', () => {
  const Notification = vi.fn(function () {})
  Object.assign(Notification, { permission: 'granted' })
  vi.stubGlobal('Notification', Notification)
  writeNotificationPreferences({ completion: true, requests: false })
  notifySessionEvent(event('turn_end'), 999)
  notifySessionEvent(event('ask_user_question'), 999)
  expect(Notification).toHaveBeenCalledTimes(1)
  writeNotificationPreferences({ completion: false, requests: true })
  notifySessionEvent(event('turn_end'), 999)
  notifySessionEvent(event('ask_user_question', 'pending'), 999)
  notifySessionEvent(event('ask_user_question', 'expired'), 999)
  notifySessionEvent(event('ask_user_question'), 1001)
  expect(Notification).toHaveBeenCalledTimes(2)
})

it.each(['default', 'denied'])(
  'never requests permission or delivers when permission is %s',
  (permission) => {
    const Notification = Object.assign(vi.fn(), {
      permission,
      requestPermission: vi.fn(),
    })
    vi.stubGlobal('Notification', Notification)
    notifySessionEvent(event('turn_end'), 999)
    expect(Notification).not.toHaveBeenCalled()
    expect(Notification.requestPermission).not.toHaveBeenCalled()
  },
)

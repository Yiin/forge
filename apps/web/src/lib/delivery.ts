import type { PendingUserMessage } from '../stores/messages'
import type { ConnectionState } from './socket'

/**
 * The live socket dropped and is trying to come back. The first connect is
 * not offline: a send then goes out over HTTP like any other.
 */
export function isOffline(connection: ConnectionState) {
  return (
    connection === 'reconnecting' ||
    connection === 'error' ||
    connection === 'disconnected'
  )
}

/**
 * zeron's quiet caption above the composer while the connection is down.
 * `offline` means the device itself has no network; it tints the dot.
 */
export function connectionNotice(
  connection: ConnectionState,
  online: boolean,
): { text: string; offline: boolean } | undefined {
  if (!isOffline(connection)) return undefined
  return online
    ? {
        text: 'Messages will send once the connection recovers.',
        offline: false,
      }
    : {
        text: "Offline, messages will send when you're back online.",
        offline: true,
      }
}

/**
 * Why a prompt request failed. fetch rejects with a TypeError when the
 * request never got an answer; any other failure is the server refusing it.
 */
export function sendFailure(error: unknown): 'unsent' | 'refused' {
  return error instanceof TypeError ? 'unsent' : 'refused'
}

/**
 * Review notes that a prompt still on its way already carries. A new send
 * leaves them out, so a note never goes to the agent twice.
 */
export function carriedNoteIds(pending: PendingUserMessage[]) {
  return new Set(
    pending
      .filter((item) => item.status === 'sending' || item.status === 'unsent')
      .flatMap((item) => item.prompt?.reviewReferences ?? [])
      .map((note) => note.id),
  )
}

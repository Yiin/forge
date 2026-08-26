import type { Ephemeral } from '@forge/protocol/events'
import type { ServerEvent } from '@forge/protocol/events'

type Listener = (event: Ephemeral) => void
type MessageListener = (event: ServerEvent) => void

export class EventBus {
  private readonly listeners = new Set<Listener>()
  private readonly messageListeners = new Set<MessageListener>()

  publishEphemeral(event: Ephemeral) {
    for (const listener of this.listeners) listener(event)
  }

  publishPersisted(event: ServerEvent) {
    for (const listener of this.messageListeners) listener(event)
  }

  /** @deprecated Use publishEphemeral. */
  publish(event: Ephemeral) {
    this.publishEphemeral(event)
  }

  /** @deprecated Use publishPersisted. */
  publishMessage(event: ServerEvent) {
    this.publishPersisted(event)
  }

  subscribeEphemeral(listener: Listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribePersisted(listener: MessageListener) {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  /** @deprecated Use subscribeEphemeral. */
  subscribe(listener: Listener) {
    return this.subscribeEphemeral(listener)
  }

  /** @deprecated Use subscribePersisted. */
  subscribeMessages(listener: MessageListener) {
    return this.subscribePersisted(listener)
  }

  get size() {
    return this.listeners.size
  }
}

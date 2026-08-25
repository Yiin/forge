import type { Ephemeral } from '@forge/protocol/events'
import type { ServerEvent } from '@forge/protocol/events'

type Listener = (event: Ephemeral) => void
type MessageListener = (event: ServerEvent) => void

export class EventBus {
  private readonly listeners = new Set<Listener>()
  private readonly messageListeners = new Set<MessageListener>()

  publish(event: Ephemeral) {
    for (const listener of this.listeners) listener(event)
  }

  publishMessage(event: ServerEvent) {
    for (const listener of this.messageListeners) listener(event)
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeMessages(listener: MessageListener) {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  get size() {
    return this.listeners.size
  }
}

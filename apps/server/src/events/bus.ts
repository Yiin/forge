import type { Ephemeral } from '@forge/protocol/events'

type Listener = (event: Ephemeral) => void

export class EventBus {
  private readonly listeners = new Set<Listener>()

  publish(event: Ephemeral) {
    for (const listener of this.listeners) listener(event)
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get size() {
    return this.listeners.size
  }
}

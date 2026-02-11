import type { WatchdogEvents } from "../types/index.js";

type Listener<T> = (data: T) => void;

export class WatchdogEmitter {
  private listeners = new Map<string, Set<(...args: never) => unknown>>();

  on<K extends keyof WatchdogEvents>(
    event: K,
    listener: Listener<WatchdogEvents[K]>,
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)?.add(listener);
    return () => this.listeners.get(event)?.delete(listener);
  }

  emit<K extends keyof WatchdogEvents>(
    event: K,
    data: WatchdogEvents[K],
  ): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const fn of set) {
        (fn as Listener<WatchdogEvents[K]>)(data);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}

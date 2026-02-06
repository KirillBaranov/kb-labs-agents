/**
 * Simple event emitter implementation for agent events
 */

import type {
  AgentEvent,
  AgentEventCallback,
  AgentEventEmitter,
  AgentEventType,
} from '@kb-labs/agent-contracts';

/**
 * Create a new event emitter
 */
export function createEventEmitter(): AgentEventEmitter {
  const listeners: Set<AgentEventCallback> = new Set();
  const typeListeners: Map<AgentEventType, Set<AgentEventCallback>> = new Map();

  return {
    emit(event: AgentEvent): void {
      // Notify all global listeners
      for (const callback of listeners) {
        try {
          callback(event);
        } catch (error) {
          console.error('[EventEmitter] Listener error:', error);
        }
      }

      // Notify type-specific listeners
      const typeCallbacks = typeListeners.get(event.type);
      if (typeCallbacks) {
        for (const callback of typeCallbacks) {
          try {
            callback(event);
          } catch (error) {
            console.error('[EventEmitter] Type listener error:', error);
          }
        }
      }
    },

    on(callback: AgentEventCallback): () => void {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },

    onType<T extends AgentEventType>(
      type: T,
      callback: (event: Extract<AgentEvent, { type: T }>) => void
    ): () => void {
      if (!typeListeners.has(type)) {
        typeListeners.set(type, new Set());
      }
      typeListeners.get(type)!.add(callback as AgentEventCallback);

      return () => {
        typeListeners.get(type)?.delete(callback as AgentEventCallback);
      };
    },
  };
}

/**
 * Helper to create events with timestamp
 */
export function createEvent<T extends AgentEvent>(
  type: T['type'],
  data: T['data'],
  options?: { sessionId?: string; taskId?: string }
): T {
  return {
    type,
    timestamp: new Date().toISOString(),
    sessionId: options?.sessionId,
    taskId: options?.taskId,
    data,
  } as T;
}

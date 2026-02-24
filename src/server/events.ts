/**
 * Internal Event Bus
 *
 * Typed event emitter for internal system events.
 * Listeners can trigger webhooks, audit log entries, or internal actions.
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 *
 * @module server/events
 */
import { EventEmitter } from 'events';

// =============================================================================
// EVENT TYPE DEFINITIONS
// =============================================================================

/** Event types emitted by the system */
export type SystemEventType =
  | 'document.ingested'
  | 'document.processed'
  | 'document.deleted'
  | 'workflow.state_changed'
  | 'annotation.created'
  | 'annotation.resolved'
  | 'search.alert_triggered'
  | 'obligation.overdue'
  | 'webhook.triggered'
  | 'user.created';

/** All valid event type values for runtime validation */
export const VALID_EVENT_TYPES: readonly SystemEventType[] = [
  'document.ingested',
  'document.processed',
  'document.deleted',
  'workflow.state_changed',
  'annotation.created',
  'annotation.resolved',
  'search.alert_triggered',
  'obligation.overdue',
  'webhook.triggered',
  'user.created',
] as const;

export interface SystemEvent {
  type: SystemEventType;
  timestamp: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  sessionId?: string;
  data: Record<string, unknown>;
}

// =============================================================================
// EVENT BUS
// =============================================================================

class EventBus extends EventEmitter {
  /** Emit a typed system event */
  emitEvent(event: SystemEvent): void {
    console.error(`[EventBus] ${event.type}: ${event.entityType ?? ''}/${event.entityId ?? ''}`);
    this.emit(event.type, event);
    this.emit('*', event); // Wildcard listener for all events
  }

  /** Subscribe to a specific event type */
  onEvent(type: SystemEventType | '*', handler: (event: SystemEvent) => void): void {
    this.on(type, handler);
  }

  /** Subscribe once */
  onceEvent(type: SystemEventType, handler: (event: SystemEvent) => void): void {
    this.once(type, handler);
  }
}

/** Singleton event bus */
export const eventBus = new EventBus();

// Set higher listener limit since many tools may subscribe
eventBus.setMaxListeners(100);

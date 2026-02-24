/**
 * Webhook Delivery Service
 *
 * Delivers events to registered webhook URLs with:
 * - HMAC-SHA256 signing (when secret configured)
 * - Exponential backoff retry (3 attempts)
 * - Auto-disable after 10 consecutive failures
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 *
 * @module services/webhook-delivery
 */
import { createHmac } from 'crypto';
import type Database from 'better-sqlite3';
import { eventBus, type SystemEvent } from '../server/events.js';
import { calculateBackoffDelay } from '../utils/backoff.js';

// =============================================================================
// TYPES
// =============================================================================

interface WebhookRow {
  id: string;
  url: string;
  events: string; // Comma-separated
  secret: string | null;
  is_active: number;
  failure_count: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_FAILURES = 10;
const MAX_RETRIES = 3;
const DELIVERY_TIMEOUT_MS = 10000;

// =============================================================================
// SIGNING
// =============================================================================

/** Sign payload with HMAC-SHA256 */
function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// =============================================================================
// DELIVERY
// =============================================================================

/** Deliver event to a single webhook with retry */
async function deliverToWebhook(webhook: WebhookRow, event: SystemEvent): Promise<boolean> {
  const payload = JSON.stringify({
    event: event.type,
    timestamp: event.timestamp,
    entity_type: event.entityType,
    entity_id: event.entityId,
    data: event.data,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Webhook-Event': event.type,
  };

  if (webhook.secret) {
    headers['X-Webhook-Signature'] = `sha256=${signPayload(payload, webhook.secret)}`;
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });

      if (response.ok) return true;

      if (response.status >= 400 && response.status < 500) {
        // Client error - don't retry
        console.error(`[Webhook] ${webhook.id} client error ${response.status} for ${event.type}`);
        return false;
      }

      // Server error - retry with backoff
      if (attempt < MAX_RETRIES - 1) {
        const delay = calculateBackoffDelay(attempt);
        console.error(
          `[Webhook] ${webhook.id} server error ${response.status}, retrying in ${delay}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      if (attempt < MAX_RETRIES - 1) {
        const delay = calculateBackoffDelay(attempt);
        console.error(
          `[Webhook] ${webhook.id} delivery error: ${error instanceof Error ? error.message : String(error)}, retrying in ${delay}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        console.error(
          `[Webhook] ${webhook.id} delivery failed after ${MAX_RETRIES} attempts: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  return false;
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/** Initialize webhook delivery for a database connection */
export function initWebhookDelivery(getConnection: () => Database.Database): void {
  eventBus.onEvent('*', async (event) => {
    let conn: Database.Database;
    try {
      conn = getConnection();
    } catch {
      return; // No database selected
    }

    let webhooks: WebhookRow[];
    try {
      webhooks = conn
        .prepare('SELECT * FROM webhooks WHERE is_active = 1')
        .all() as WebhookRow[];
    } catch (error) {
      console.error(
        `[Webhook] Failed to query webhooks: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    for (const webhook of webhooks) {
      // Check if webhook is subscribed to this event type
      const subscribedEvents = webhook.events.split(',').map((e) => e.trim());
      if (!subscribedEvents.includes(event.type) && !subscribedEvents.includes('*')) continue;

      const success = await deliverToWebhook(webhook, event);

      try {
        if (success) {
          conn
            .prepare(
              `UPDATE webhooks SET last_triggered_at = datetime('now'), failure_count = 0 WHERE id = ?`
            )
            .run(webhook.id);
        } else {
          const newCount = webhook.failure_count + 1;
          if (newCount >= MAX_FAILURES) {
            conn
              .prepare('UPDATE webhooks SET failure_count = ?, is_active = 0 WHERE id = ?')
              .run(newCount, webhook.id);
            console.error(`[Webhook] ${webhook.id} disabled after ${MAX_FAILURES} failures`);
          } else {
            conn
              .prepare('UPDATE webhooks SET failure_count = ? WHERE id = ?')
              .run(newCount, webhook.id);
          }
        }
      } catch (error) {
        console.error(
          `[Webhook] Failed to update webhook ${webhook.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  });

  console.error('[WebhookDelivery] Initialized - listening for events');
}

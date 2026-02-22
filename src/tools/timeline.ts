/**
 * Temporal Analytics MCP Tools
 *
 * Tools for analyzing processing volume and throughput over time.
 * Provides time-bucketed views of document processing activity.
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/timeline
 */

import { z } from 'zod';
import { formatResponse, handleError, type ToolResponse, type ToolDefinition } from './shared.js';
import { successResult } from '../server/types.js';
import { requireDatabase } from '../server/state.js';
import { validateInput } from '../utils/validation.js';

// ===============================================================================
// VALIDATION SCHEMAS
// ===============================================================================

const TimelineAnalyticsInput = z.object({
  bucket: z.enum(['hourly', 'daily', 'weekly', 'monthly']).default('daily'),
  metric: z
    .enum(['documents', 'pages', 'chunks', 'embeddings', 'images', 'cost'])
    .default('documents'),
  created_after: z.string().optional(),
  created_before: z.string().optional(),
});

// ===============================================================================
// TOOL HANDLERS
// ===============================================================================

/**
 * Handle ocr_timeline_analytics - Processing volume over time buckets
 */
async function handleTimelineAnalytics(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(TimelineAnalyticsInput, params);
    const { db } = requireDatabase();

    const bucket = input.bucket ?? 'daily';
    const metric = input.metric ?? 'documents';

    const data = db.getTimelineStats({
      bucket,
      metric,
      created_after: input.created_after,
      created_before: input.created_before,
    });

    return formatResponse(
      successResult({
        bucket,
        metric,
        total_periods: data.length,
        total_count: data.reduce((sum, d) => sum + d.count, 0),
        filters: {
          created_after: input.created_after ?? null,
          created_before: input.created_before ?? null,
        },
        data,
        next_steps: [{ tool: 'ocr_report_performance', description: 'Get detailed pipeline performance' }, { tool: 'ocr_quality_trends', description: 'View quality trends over the same period' }],
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

// ===============================================================================
// TOOL DEFINITIONS
// ===============================================================================

/**
 * Timeline tools collection for MCP server registration
 */
export const timelineTools: Record<string, ToolDefinition> = {
  ocr_timeline_analytics: {
    description:
      '[STATUS] Use to view processing volume trends over time. Returns counts bucketed by hour/day/week/month for documents, pages, chunks, embeddings, images, or cost.',
    inputSchema: {
      bucket: z
        .enum(['hourly', 'daily', 'weekly', 'monthly'])
        .default('daily')
        .describe('Time bucket granularity'),
      metric: z
        .enum(['documents', 'pages', 'chunks', 'embeddings', 'images', 'cost'])
        .default('documents')
        .describe('Metric to track over time'),
      created_after: z
        .string()
        .optional()
        .describe('Filter data created after this ISO 8601 timestamp'),
      created_before: z
        .string()
        .optional()
        .describe('Filter data created before this ISO 8601 timestamp'),
    },
    handler: handleTimelineAnalytics,
  },
};

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

const ThroughputAnalyticsInput = z.object({
  bucket: z.enum(['hourly', 'daily', 'weekly', 'monthly']).default('daily'),
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
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Handle ocr_throughput_analytics - Processing throughput metrics per time bucket
 */
async function handleThroughputAnalytics(
  params: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    const input = validateInput(ThroughputAnalyticsInput, params);
    const { db } = requireDatabase();

    const bucket = input.bucket ?? 'daily';

    const data = db.getThroughputAnalytics({
      bucket,
      created_after: input.created_after,
      created_before: input.created_before,
    });

    // Compute overall summary
    const totalPages = data.reduce((sum, d) => sum + d.pages_processed, 0);
    const totalEmbeddings = data.reduce((sum, d) => sum + d.embeddings_generated, 0);
    const totalImages = data.reduce((sum, d) => sum + d.images_processed, 0);
    const totalOcrMs = data.reduce((sum, d) => sum + d.total_ocr_duration_ms, 0);
    const totalEmbMs = data.reduce((sum, d) => sum + d.total_embedding_duration_ms, 0);

    return formatResponse(
      successResult({
        bucket,
        total_periods: data.length,
        filters: {
          created_after: input.created_after ?? null,
          created_before: input.created_before ?? null,
        },
        summary: {
          total_pages_processed: totalPages,
          total_embeddings_generated: totalEmbeddings,
          total_images_processed: totalImages,
          total_ocr_duration_ms: totalOcrMs,
          total_embedding_duration_ms: totalEmbMs,
          overall_avg_ms_per_page: totalPages > 0
            ? Math.round((totalOcrMs / totalPages) * 100) / 100
            : 0,
          overall_avg_ms_per_embedding: totalEmbeddings > 0
            ? Math.round((totalEmbMs / totalEmbeddings) * 100) / 100
            : 0,
        },
        data,
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
      'Processing volume over time buckets (hourly, daily, weekly, monthly). Track documents, pages, chunks, embeddings, images, or cost over time.',
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

  ocr_throughput_analytics: {
    description:
      'Processing throughput metrics per time bucket. Shows pages processed, embeddings generated, images processed, and average processing times.',
    inputSchema: {
      bucket: z
        .enum(['hourly', 'daily', 'weekly', 'monthly'])
        .default('daily')
        .describe('Time bucket granularity'),
      created_after: z
        .string()
        .optional()
        .describe('Filter data created after this ISO 8601 timestamp'),
      created_before: z
        .string()
        .optional()
        .describe('Filter data created before this ISO 8601 timestamp'),
    },
    handler: handleThroughputAnalytics,
  },
};

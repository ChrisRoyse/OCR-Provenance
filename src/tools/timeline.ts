/**
 * Temporal Analytics MCP Tools
 *
 * NOTE: ocr_timeline_analytics merged into ocr_trends (reports.ts) in V7 MERGE-C.
 * This module is kept because index.ts imports timelineTools.
 *
 * @module tools/timeline
 */

import type { ToolDefinition } from './shared.js';

/**
 * Timeline tools collection for MCP server registration.
 * Empty after V7 MERGE-C: ocr_timeline_analytics → ocr_trends in reports.ts.
 */
export const timelineTools: Record<string, ToolDefinition> = {};

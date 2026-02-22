/**
 * Manual E2E Test: ocr_guide tool + AI Agent Optimization Audit changes
 *
 * Tests:
 * 1. ocr_guide with no database selected
 * 2. ocr_guide with database selected (real data)
 * 3. ocr_guide with intent='search'
 * 4. ocr_guide with intent='status'
 * 5. next_steps in ocr_db_select response
 * 6. next_steps in ocr_document_list response
 * 7. Error message improvements (databaseNotSelectedError, documentNotFoundError)
 * 8. Tool description tier tags ([CORE], [PROCESSING], [SEARCH], etc.)
 * 9. ocr_guide with empty database (0 documents)
 * 10. ocr_guide with invalid intent (Zod validation)
 *
 * Run: npx vitest run tests/manual/guide-e2e-test.test.ts --config vitest.config.all.ts
 *
 * CRITICAL: NEVER use console.log() in source files - only in tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  state,
  selectDatabase,
  createDatabase,
  deleteDatabase,
  clearDatabase,
} from '../../src/server/state.js';

import { intelligenceTools } from '../../src/tools/intelligence.js';
import { databaseTools } from '../../src/tools/database.js';
import { documentTools } from '../../src/tools/documents.js';
import { searchTools } from '../../src/tools/search.js';
import { ingestionTools } from '../../src/tools/ingestion.js';
import { provenanceTools } from '../../src/tools/provenance.js';
import { configTools } from '../../src/tools/config.js';
import { vlmTools } from '../../src/tools/vlm.js';
import { imageTools } from '../../src/tools/images.js';
import { evaluationTools } from '../../src/tools/evaluation.js';
import { extractionTools } from '../../src/tools/extraction.js';
import { reportTools } from '../../src/tools/reports.js';
import { formFillTools } from '../../src/tools/form-fill.js';
import { structuredExtractionTools } from '../../src/tools/extraction-structured.js';
import { fileManagementTools } from '../../src/tools/file-management.js';
import { comparisonTools } from '../../src/tools/comparison.js';
import { clusteringTools } from '../../src/tools/clustering.js';
import { chunkTools } from '../../src/tools/chunks.js';
import { embeddingTools } from '../../src/tools/embeddings.js';
import { timelineTools } from '../../src/tools/timeline.js';
import { tagTools } from '../../src/tools/tags.js';
import { healthTools } from '../../src/tools/health.js';

import {
  databaseNotSelectedError,
  documentNotFoundError,
} from '../../src/server/errors.js';

// ===============================================================================
// HELPERS
// ===============================================================================

type ToolModule = Record<string, { description: string; handler: (p: Record<string, unknown>) => Promise<unknown> }>;

async function callTool(tools: ToolModule, name: string, params: Record<string, unknown> = {}) {
  const tool = tools[name];
  if (!tool) throw new Error(`Tool not found: ${name}. Available: ${Object.keys(tools).join(', ')}`);
  const raw = (await tool.handler(params)) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(raw.content[0].text) as {
    success: boolean;
    data?: Record<string, unknown>;
    error?: Record<string, unknown>;
  };
}

function ok(result: { success: boolean; data?: Record<string, unknown>; error?: Record<string, unknown> }): Record<string, unknown> {
  if (!result.success) {
    console.error('[FAIL]', JSON.stringify(result.error, null, 2));
  }
  expect(result.success).toBe(true);
  expect(result.data).toBeDefined();
  return result.data!;
}

// ===============================================================================
// TEST: ocr_guide - no database selected
// ===============================================================================

describe('Test 1: ocr_guide with no database selected', () => {
  beforeAll(() => {
    // Ensure no database is selected
    clearDatabase();
  });

  it('should return no_database_selected status with next_steps', async () => {
    console.log('[Test 1] State BEFORE: currentDatabaseName =', state.currentDatabaseName);

    const result = await callTool(intelligenceTools as ToolModule, 'ocr_guide', {});
    const data = ok(result);

    console.log('[Test 1] Response status:', data.status);
    console.log('[Test 1] next_steps:', JSON.stringify(data.next_steps, null, 2));

    expect(data.status).toBe('no_database_selected');
    expect(data.next_steps).toBeDefined();
    expect(Array.isArray(data.next_steps)).toBe(true);

    const nextSteps = data.next_steps as Array<{ tool: string; description: string; priority: string }>;
    expect(nextSteps.length).toBeGreaterThan(0);

    // Should suggest a tool (either ocr_db_select or ocr_db_create)
    const suggestedTools = nextSteps.map(s => s.tool);
    const hasValidSuggestion = suggestedTools.includes('ocr_db_select') || suggestedTools.includes('ocr_db_create');
    expect(hasValidSuggestion).toBe(true);

    // Each step should have tool, description, priority
    for (const step of nextSteps) {
      expect(step.tool).toBeDefined();
      expect(typeof step.tool).toBe('string');
      expect(step.description).toBeDefined();
      expect(typeof step.description).toBe('string');
      expect(step.priority).toBeDefined();
    }

    console.log('[Test 1] State AFTER: currentDatabaseName =', state.currentDatabaseName);
    console.log('[Test 1] PASSED');
  });
});

// ===============================================================================
// TEST: ocr_guide - with database selected
// ===============================================================================

describe('Test 2: ocr_guide with database selected (chunking-diversity-test)', () => {
  beforeAll(() => {
    selectDatabase('chunking-diversity-test');
  });

  afterAll(() => {
    clearDatabase();
  });

  it('should return ready status with database_stats and next_steps', async () => {
    console.log('[Test 2] State BEFORE: currentDatabaseName =', state.currentDatabaseName);

    const result = await callTool(intelligenceTools as ToolModule, 'ocr_guide', {});
    const data = ok(result);

    console.log('[Test 2] Response status:', data.status);
    console.log('[Test 2] context.database_stats:', JSON.stringify((data.context as Record<string, unknown>)?.database_stats, null, 2));

    // Status should be 'ready' when a database is selected
    expect(data.status).toBe('ready');

    // Context should have database_stats
    expect(data.context).toBeDefined();
    const context = data.context as Record<string, unknown>;
    expect(context.database_stats).toBeDefined();

    const stats = context.database_stats as Record<string, unknown>;
    expect(typeof stats.total_documents).toBe('number');
    expect((stats.total_documents as number)).toBeGreaterThan(0);
    expect(typeof stats.chunks).toBe('number');
    expect(typeof stats.embeddings).toBe('number');

    // next_steps should exist
    expect(data.next_steps).toBeDefined();
    expect(Array.isArray(data.next_steps)).toBe(true);
    const nextSteps = data.next_steps as Array<{ tool: string }>;
    expect(nextSteps.length).toBeGreaterThan(0);

    // Message should include database name
    expect(typeof data.message).toBe('string');
    expect((data.message as string)).toContain('chunking-diversity-test');

    console.log('[Test 2] State AFTER: currentDatabaseName =', state.currentDatabaseName);
    console.log('[Test 2] PASSED');
  });
});

// ===============================================================================
// TEST: ocr_guide with intent='search'
// ===============================================================================

describe('Test 3: ocr_guide with intent=search', () => {
  beforeAll(() => {
    selectDatabase('chunking-diversity-test');
  });

  afterAll(() => {
    clearDatabase();
  });

  it('should suggest ocr_search in next_steps', async () => {
    console.log('[Test 3] State BEFORE: currentDatabaseName =', state.currentDatabaseName);

    const result = await callTool(intelligenceTools as ToolModule, 'ocr_guide', { intent: 'search' });
    const data = ok(result);

    console.log('[Test 3] next_steps:', JSON.stringify(data.next_steps, null, 2));

    const nextSteps = data.next_steps as Array<{ tool: string }>;
    const suggestedTools = nextSteps.map(s => s.tool);
    expect(suggestedTools).toContain('ocr_search');

    console.log('[Test 3] PASSED');
  });
});

// ===============================================================================
// TEST: ocr_guide with intent='status'
// ===============================================================================

describe('Test 4: ocr_guide with intent=status', () => {
  beforeAll(() => {
    selectDatabase('chunking-diversity-test');
  });

  afterAll(() => {
    clearDatabase();
  });

  it('should suggest ocr_health_check in next_steps', async () => {
    console.log('[Test 4] State BEFORE: currentDatabaseName =', state.currentDatabaseName);

    const result = await callTool(intelligenceTools as ToolModule, 'ocr_guide', { intent: 'status' });
    const data = ok(result);

    console.log('[Test 4] next_steps:', JSON.stringify(data.next_steps, null, 2));

    const nextSteps = data.next_steps as Array<{ tool: string }>;
    const suggestedTools = nextSteps.map(s => s.tool);
    expect(suggestedTools).toContain('ocr_health_check');

    console.log('[Test 4] PASSED');
  });
});

// ===============================================================================
// TEST: next_steps in ocr_db_select response
// ===============================================================================

describe('Test 5: next_steps in ocr_db_select response', () => {
  beforeAll(() => {
    clearDatabase();
  });

  afterAll(() => {
    clearDatabase();
  });

  it('should include next_steps array in db_select response', async () => {
    console.log('[Test 5] State BEFORE: currentDatabaseName =', state.currentDatabaseName);

    const result = await callTool(databaseTools as ToolModule, 'ocr_db_select', {
      database_name: 'chunking-diversity-test',
    });
    const data = ok(result);

    console.log('[Test 5] next_steps:', JSON.stringify(data.next_steps, null, 2));

    expect(data.next_steps).toBeDefined();
    expect(Array.isArray(data.next_steps)).toBe(true);
    const nextSteps = data.next_steps as Array<{ tool: string; description: string }>;
    expect(nextSteps.length).toBeGreaterThan(0);

    // Each step should have tool and description
    for (const step of nextSteps) {
      expect(step.tool).toBeDefined();
      expect(typeof step.tool).toBe('string');
      expect(step.description).toBeDefined();
      expect(typeof step.description).toBe('string');
    }

    // Verify the response also has selected:true and stats
    expect(data.selected).toBe(true);
    expect(data.stats).toBeDefined();

    console.log('[Test 5] State AFTER: currentDatabaseName =', state.currentDatabaseName);
    console.log('[Test 5] PASSED');
  });
});

// ===============================================================================
// TEST: next_steps in ocr_document_list response
// ===============================================================================

describe('Test 6: next_steps in ocr_document_list response', () => {
  beforeAll(() => {
    selectDatabase('chunking-diversity-test');
  });

  afterAll(() => {
    clearDatabase();
  });

  it('should include next_steps array in document_list response', async () => {
    console.log('[Test 6] State BEFORE: currentDatabaseName =', state.currentDatabaseName);

    const result = await callTool(documentTools as ToolModule, 'ocr_document_list', {
      limit: 5,
      offset: 0,
    });
    const data = ok(result);

    console.log('[Test 6] next_steps:', JSON.stringify(data.next_steps, null, 2));
    console.log('[Test 6] total documents:', data.total);

    expect(data.next_steps).toBeDefined();
    expect(Array.isArray(data.next_steps)).toBe(true);
    const nextSteps = data.next_steps as Array<{ tool: string; description: string }>;
    expect(nextSteps.length).toBeGreaterThan(0);

    // Each step should have tool and description
    for (const step of nextSteps) {
      expect(step.tool).toBeDefined();
      expect(typeof step.tool).toBe('string');
      expect(step.description).toBeDefined();
      expect(typeof step.description).toBe('string');
    }

    // Verify the response also has documents
    expect(data.documents).toBeDefined();
    expect(Array.isArray(data.documents)).toBe(true);

    console.log('[Test 6] PASSED');
  });
});

// ===============================================================================
// TEST: Error message improvements
// ===============================================================================

describe('Test 7: Error message improvements', () => {
  it('databaseNotSelectedError should contain ocr_db_list', () => {
    console.log('[Test 7a] Testing databaseNotSelectedError');

    const error = databaseNotSelectedError();
    expect(error.message).toContain('ocr_db_list');
    expect(error.category).toBe('DATABASE_NOT_SELECTED');

    console.log('[Test 7a] Error message:', error.message);
    console.log('[Test 7a] PASSED');
  });

  it('documentNotFoundError should contain ocr_document_list', () => {
    console.log('[Test 7b] Testing documentNotFoundError');

    const error = documentNotFoundError('test-id-12345');
    expect(error.message).toContain('ocr_document_list');
    expect(error.message).toContain('test-id-12345');
    expect(error.category).toBe('DOCUMENT_NOT_FOUND');

    console.log('[Test 7b] Error message:', error.message);
    console.log('[Test 7b] PASSED');
  });
});

// ===============================================================================
// TEST: Tool description tier tags
// ===============================================================================

describe('Test 8: Tool description tier tags', () => {
  const allToolModules: Record<string, ToolModule> = {
    database: databaseTools as ToolModule,
    ingestion: ingestionTools as ToolModule,
    search: searchTools as ToolModule,
    documents: documentTools as ToolModule,
    provenance: provenanceTools as ToolModule,
    config: configTools as ToolModule,
    vlm: vlmTools as ToolModule,
    images: imageTools as ToolModule,
    evaluation: evaluationTools as ToolModule,
    extraction: extractionTools as ToolModule,
    reports: reportTools as ToolModule,
    formFill: formFillTools as ToolModule,
    structuredExtraction: structuredExtractionTools as ToolModule,
    fileManagement: fileManagementTools as ToolModule,
    comparison: comparisonTools as ToolModule,
    clustering: clusteringTools as ToolModule,
    chunks: chunkTools as ToolModule,
    embeddings: embeddingTools as ToolModule,
    timeline: timelineTools as ToolModule,
    tags: tagTools as ToolModule,
    health: healthTools as ToolModule,
    intelligence: intelligenceTools as ToolModule,
  };

  const validTierTags = ['[CORE]', '[PROCESSING]', '[SEARCH]', '[ANALYSIS]', '[ADMIN]'];

  it('every tool description should start with a valid tier tag', () => {
    let totalTools = 0;
    const toolsByTier: Record<string, string[]> = {};
    const missingTier: string[] = [];

    for (const [moduleName, tools] of Object.entries(allToolModules)) {
      for (const [toolName, toolDef] of Object.entries(tools)) {
        // Skip non-tool entries (like shared helpers)
        if (!toolDef.description || typeof toolDef.description !== 'string') continue;
        if (!toolDef.handler || typeof toolDef.handler !== 'function') continue;

        totalTools++;
        const desc = toolDef.description;
        const matchedTag = validTierTags.find(tag => desc.startsWith(tag));

        if (matchedTag) {
          if (!toolsByTier[matchedTag]) toolsByTier[matchedTag] = [];
          toolsByTier[matchedTag].push(toolName);
        } else {
          missingTier.push(`${moduleName}.${toolName}: "${desc.substring(0, 50)}..."`);
        }
      }
    }

    console.log(`[Test 8] Total tools found: ${totalTools}`);
    console.log('[Test 8] Tools by tier:');
    for (const [tier, tools] of Object.entries(toolsByTier)) {
      console.log(`  ${tier}: ${tools.length} tools`);
    }

    if (missingTier.length > 0) {
      console.error('[Test 8] Tools MISSING tier tag:');
      for (const name of missingTier) {
        console.error(`  - ${name}`);
      }
    }

    expect(missingTier).toEqual([]);
    // Verify we found the expected number of tools (127 total across 22 modules)
    expect(totalTools).toBe(127);

    console.log('[Test 8] PASSED');
  });
});

// ===============================================================================
// TEST: ocr_guide with empty database
// ===============================================================================

describe('Test 9: ocr_guide with empty database', () => {
  const tempDbName = `guide-test-temp-${Date.now()}`;

  beforeAll(() => {
    createDatabase(tempDbName);
  });

  afterAll(() => {
    try {
      clearDatabase();
      deleteDatabase(tempDbName);
    } catch (err) {
      console.error(`[Test 9] Cleanup error: ${err}`);
    }
  });

  it('should recommend ingestion when database has 0 documents', async () => {
    console.log('[Test 9] State BEFORE: currentDatabaseName =', state.currentDatabaseName);
    console.log(`[Test 9] Temp database created: ${tempDbName}`);

    const result = await callTool(intelligenceTools as ToolModule, 'ocr_guide', {});
    const data = ok(result);

    console.log('[Test 9] Response status:', data.status);
    console.log('[Test 9] next_steps:', JSON.stringify(data.next_steps, null, 2));

    // Status should be 'ready' (database IS selected, just empty)
    expect(data.status).toBe('ready');

    // Context should show 0 documents
    const context = data.context as Record<string, unknown>;
    const stats = context.database_stats as Record<string, unknown>;
    expect(stats.total_documents).toBe(0);

    // next_steps should recommend ingestion tools
    const nextSteps = data.next_steps as Array<{ tool: string; description: string; priority: string }>;
    const suggestedTools = nextSteps.map(s => s.tool);

    // When docCount === 0 and no intent, should suggest ingestion
    const hasIngestionSuggestion =
      suggestedTools.includes('ocr_ingest_files') ||
      suggestedTools.includes('ocr_ingest_directory');
    expect(hasIngestionSuggestion).toBe(true);

    console.log('[Test 9] State AFTER: currentDatabaseName =', state.currentDatabaseName);
    console.log('[Test 9] PASSED');
  });
});

// ===============================================================================
// TEST: ocr_guide with invalid intent
// ===============================================================================

describe('Test 10: ocr_guide with invalid intent (Zod validation)', () => {
  beforeAll(() => {
    selectDatabase('chunking-diversity-test');
  });

  afterAll(() => {
    clearDatabase();
  });

  it('should return a validation error for invalid intent value', async () => {
    console.log('[Test 10] Testing invalid intent value');

    const result = await callTool(intelligenceTools as ToolModule, 'ocr_guide', {
      intent: 'invalid_value_that_should_fail',
    });

    console.log('[Test 10] Result success:', result.success);
    console.log('[Test 10] Result error:', JSON.stringify(result.error, null, 2));

    // Zod should reject the invalid enum value
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    const error = result.error as Record<string, unknown>;
    expect(error.category).toBe('VALIDATION_ERROR');

    console.log('[Test 10] PASSED');
  });
});

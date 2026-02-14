/**
 * Question-Answering MCP Tools
 *
 * Tools: ocr_question_answer
 *
 * CRITICAL: NEVER use console.log() - stdout is reserved for JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module tools/question-answer
 */

import { z } from 'zod';
import { formatResponse, handleError, type ToolDefinition, type ToolResponse } from './shared.js';
import { validateInput } from '../utils/validation.js';
import { requireDatabase } from '../server/state.js';
import { successResult } from '../server/types.js';
import { GeminiClient } from '../services/gemini/client.js';

// Input schema
const QuestionAnswerInput = z.object({
  question: z.string().min(1).max(2000).describe('The question to answer'),
  document_filter: z.array(z.string()).optional()
    .describe('Restrict to specific documents'),
  include_sources: z.boolean().default(true)
    .describe('Include source chunks in the response'),
  include_entity_context: z.boolean().default(true)
    .describe('Include knowledge graph entity information'),
  include_kg_paths: z.boolean().default(true)
    .describe('Include knowledge graph relationship paths'),
  max_context_length: z.number().int().min(500).max(50000).default(8000)
    .describe('Maximum context length in characters'),
  limit: z.number().int().min(1).max(20).default(5)
    .describe('Maximum search results to include'),
  temperature: z.number().min(0).max(1).default(0.3)
    .describe('Temperature for answer generation (lower = more factual)'),
});

// Handler
async function handleQuestionAnswer(params: Record<string, unknown>): Promise<ToolResponse> {
  try {
    const input = validateInput(QuestionAnswerInput, params);
    const { db } = requireDatabase();
    const conn = db.getConnection();

    const startTime = Date.now();

    // Resolve defaults (Zod defaults are applied but TS infers them as possibly undefined)
    const limit = input.limit ?? 5;
    const maxContextLength = input.max_context_length ?? 8000;

    // Step 1: Build RAG context using hybrid search + entity enrichment
    // Perform hybrid search (BM25 + semantic) for the question
    const searchLimit = Math.min(limit * 2, 40); // Fetch more for filtering

    // BM25 search
    const bm25Results: Array<{ chunk_id: string; text: string; document_id: string; score: number; page_number: number | null }> = [];
    try {
      const ftsRows = conn.prepare(`
        SELECT c.id as chunk_id, c.text, c.document_id, c.page_number,
               rank as score
        FROM chunks_fts fts
        JOIN chunks c ON c.id = fts.chunk_id
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(input.question.replace(/['"]/g, ''), searchLimit) as Array<{
        chunk_id: string; text: string; document_id: string; score: number; page_number: number | null;
      }>;
      bm25Results.push(...ftsRows);
    } catch {
      // FTS may not be populated
    }

    // Filter by document_filter if provided
    let filteredResults = bm25Results;
    if (input.document_filter && input.document_filter.length > 0) {
      const docSet = new Set(input.document_filter);
      filteredResults = bm25Results.filter(r => docSet.has(r.document_id));
    }

    // Take top results
    const topResults = filteredResults.slice(0, limit);

    if (topResults.length === 0) {
      return formatResponse(successResult({
        question: input.question,
        answer: 'No relevant documents found to answer this question. Please ensure documents have been ingested and processed.',
        confidence: 0,
        sources: [],
        processing_duration_ms: Date.now() - startTime,
      }));
    }

    // Step 2: Build context block
    let context = '';
    const sources: Array<{
      chunk_id: string;
      document_id: string;
      page_number: number | null;
      text_excerpt: string;
    }> = [];

    for (const result of topResults) {
      const excerpt = result.text.slice(0, Math.floor(maxContextLength / limit));
      context += `\n---\n[Document: ${result.document_id}, Page: ${result.page_number ?? 'N/A'}]\n${excerpt}\n`;
      if (input.include_sources) {
        sources.push({
          chunk_id: result.chunk_id,
          document_id: result.document_id,
          page_number: result.page_number,
          text_excerpt: excerpt.slice(0, 300),
        });
      }
    }

    // Step 3: Add entity context if requested
    let entityContext = '';
    const entities: Array<{ name: string; type: string; mentions: number }> = [];
    if (input.include_entity_context) {
      try {
        const docIds = [...new Set(topResults.map(r => r.document_id))];
        const placeholders = docIds.map(() => '?').join(',');
        const entityRows = conn.prepare(`
          SELECT e.raw_text, e.entity_type, COUNT(em.id) as mention_count
          FROM entities e
          JOIN entity_mentions em ON em.entity_id = e.id
          WHERE e.document_id IN (${placeholders})
          GROUP BY e.raw_text, e.entity_type
          ORDER BY mention_count DESC
          LIMIT 30
        `).all(...docIds) as Array<{ raw_text: string; entity_type: string; mention_count: number }>;

        if (entityRows.length > 0) {
          entityContext = '\n\n## Key Entities:\n';
          for (const e of entityRows) {
            entityContext += `- ${e.raw_text} (${e.entity_type}, ${e.mention_count} mentions)\n`;
            entities.push({ name: e.raw_text, type: e.entity_type, mentions: e.mention_count });
          }
        }
      } catch {
        // Entity tables may not have data
      }
    }

    // Step 4: Add KG path context if requested
    let kgContext = '';
    if (input.include_kg_paths && entities.length >= 2) {
      try {
        // Try to find paths between top entities
        const topEntityNames = entities.slice(0, 3).map(e => e.name);
        const pathRows = conn.prepare(`
          SELECT ke.id, sn.canonical_name as source_name, tn.canonical_name as target_name,
                 ke.relationship_type, ke.weight
          FROM knowledge_edges ke
          JOIN knowledge_nodes sn ON ke.source_node_id = sn.id
          JOIN knowledge_nodes tn ON ke.target_node_id = tn.id
          WHERE (LOWER(sn.canonical_name) IN (${topEntityNames.map(() => '?').join(',')})
              OR LOWER(tn.canonical_name) IN (${topEntityNames.map(() => '?').join(',')}))
          LIMIT 20
        `).all(...topEntityNames.map(n => n.toLowerCase()), ...topEntityNames.map(n => n.toLowerCase())) as Array<{
          id: string; source_name: string; target_name: string; relationship_type: string; weight: number;
        }>;

        if (pathRows.length > 0) {
          kgContext = '\n\n## Entity Relationships:\n';
          for (const p of pathRows) {
            kgContext += `- ${p.source_name} --[${p.relationship_type}]--> ${p.target_name} (weight: ${p.weight})\n`;
          }
        }
      } catch {
        // KG may not exist
      }
    }

    // Step 5: Generate answer using Gemini
    const fullContext = context + entityContext + kgContext;
    const truncatedContext = fullContext.slice(0, maxContextLength);

    const gemini = new GeminiClient({ temperature: input.temperature });
    const prompt = `You are a precise document analysis assistant. Answer the following question based ONLY on the provided context. If the context doesn't contain enough information, say so clearly. Be concise and factual.

## Context:
${truncatedContext}

## Question:
${input.question}

## Instructions:
- Answer based ONLY on the provided context
- Cite specific details from the documents
- If the answer is uncertain, indicate your confidence level
- If entities and relationships are provided, use them to inform your answer
- Be concise but thorough`;

    let answer = '';
    let confidence = 0;
    try {
      const geminiResult = await gemini.fast(prompt);
      answer = geminiResult.text || 'Unable to generate answer.';
      // Estimate confidence based on context relevance
      confidence = Math.min(1, topResults.length / limit);
    } catch (geminiError) {
      const geminiMsg = geminiError instanceof Error ? geminiError.message : String(geminiError);
      console.error(`[WARN] Gemini answer generation failed: ${geminiMsg}`);
      answer = `Answer generation failed: ${geminiMsg}. Here is the relevant context:\n\n${truncatedContext.slice(0, 2000)}`;
      confidence = 0;
    }

    const processingDurationMs = Date.now() - startTime;

    return formatResponse(successResult({
      question: input.question,
      answer,
      confidence,
      sources_used: topResults.length,
      entities_found: entities.length,
      sources: input.include_sources ? sources : undefined,
      entities: input.include_entity_context ? entities.slice(0, 10) : undefined,
      processing_duration_ms: processingDurationMs,
    }));
  } catch (error) {
    return handleError(error);
  }
}

export const questionAnswerTools: Record<string, ToolDefinition> = {
  'ocr_question_answer': {
    description: 'Answer questions about documents using RAG (retrieval-augmented generation). Searches documents, enriches with entity context and knowledge graph relationships, then generates an answer using Gemini AI.',
    inputSchema: QuestionAnswerInput.shape,
    handler: handleQuestionAnswer,
  },
};

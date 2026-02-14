/**
 * Tool Definitions Validation Tests
 *
 * Validates that all tool files export properly shaped tool definitions
 * with description, inputSchema, and handler for each tool.
 */
import { describe, it, expect } from 'vitest';

describe('Tool definitions validation', () => {
  const toolModules = [
    { name: 'images', importPath: '../../../src/tools/images.js', exportName: 'imageTools' },
    { name: 'vlm', importPath: '../../../src/tools/vlm.js', exportName: 'vlmTools' },
    { name: 'form-fill', importPath: '../../../src/tools/form-fill.js', exportName: 'formFillTools' },
    { name: 'extraction-structured', importPath: '../../../src/tools/extraction-structured.js', exportName: 'structuredExtractionTools' },
    { name: 'question-answer', importPath: '../../../src/tools/question-answer.js', exportName: 'questionAnswerTools' },
    { name: 'evaluation', importPath: '../../../src/tools/evaluation.js', exportName: 'evaluationTools' },
    { name: 'extraction', importPath: '../../../src/tools/extraction.js', exportName: 'extractionTools' },
  ];

  for (const mod of toolModules) {
    describe(`${mod.name} tools`, () => {
      it(`should export ${mod.exportName} with valid tool definitions`, async () => {
        const module = await import(mod.importPath);
        const tools = module[mod.exportName];
        expect(tools).toBeDefined();

        const toolNames = Object.keys(tools);
        expect(toolNames.length).toBeGreaterThan(0);

        for (const toolName of toolNames) {
          const tool = tools[toolName];

          // Each tool must have a non-empty description string
          expect(tool.description, `${toolName} missing description`).toBeDefined();
          expect(typeof tool.description, `${toolName} description not string`).toBe('string');
          expect(tool.description.length, `${toolName} description empty`).toBeGreaterThan(0);

          // Each tool must have a handler function
          expect(tool.handler, `${toolName} missing handler`).toBeDefined();
          expect(typeof tool.handler, `${toolName} handler not function`).toBe('function');

          // Each tool must have an inputSchema object (Record<string, ZodTypeAny>)
          expect(tool.inputSchema, `${toolName} missing inputSchema`).toBeDefined();
          expect(typeof tool.inputSchema, `${toolName} inputSchema not object`).toBe('object');
          expect(tool.inputSchema, `${toolName} inputSchema should not be null`).not.toBeNull();
          // inputSchema keys should either be empty (no params) or each value should be a Zod schema
          for (const fieldName of Object.keys(tool.inputSchema)) {
            const field = tool.inputSchema[fieldName];
            expect(field, `${toolName}.inputSchema.${fieldName} should be defined`).toBeDefined();
            // Zod schemas have a _def property
            expect(field._def, `${toolName}.inputSchema.${fieldName} should be a Zod schema`).toBeDefined();
          }
        }
      });
    });
  }
});

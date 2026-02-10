/**
 * Knowledge Graph Export Service
 *
 * Exports the knowledge graph in standard formats for external analysis tools:
 * - GraphML (XML for Gephi/yEd/NetworkX)
 * - CSV (two files: nodes + edges)
 * - JSON-LD (W3C semantic web standard)
 *
 * CRITICAL: NEVER use console.log() - stdout is JSON-RPC protocol.
 * Use console.error() for all logging.
 *
 * @module services/knowledge-graph/export-service
 */

import type Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { EntityType } from '../../models/entity.js';
import type { RelationshipType } from '../../models/knowledge-graph.js';

// ============================================================
// Types
// ============================================================

export interface ExportOptions {
  entity_type_filter?: EntityType[];
  relationship_type_filter?: RelationshipType[];
  min_confidence?: number;
  min_document_count?: number;
  include_metadata?: boolean;
}

export interface ExportResult {
  format: string;
  files_written: string[];
  node_count: number;
  edge_count: number;
}

interface NodeRow {
  id: string;
  entity_type: string;
  canonical_name: string;
  normalized_name: string;
  document_count: number;
  mention_count: number;
  avg_confidence: number;
  edge_count: number;
  metadata: string | null;
  aliases: string | null;
}

interface EdgeRow {
  id: string;
  source_node_id: string;
  target_node_id: string;
  relationship_type: string;
  weight: number;
  evidence_count: number;
  document_ids: string;
  metadata: string | null;
}

// ============================================================
// Data Filtering
// ============================================================

/**
 * Retrieve filtered nodes and edges from the database.
 *
 * Nodes are filtered by entity_type, min_confidence, and min_document_count.
 * Edges are filtered to only include connections between selected nodes,
 * and optionally by relationship_type.
 *
 * @param db - Database connection
 * @param options - Export filter options
 * @returns Filtered nodes and edges
 */
function getFilteredData(
  db: Database.Database,
  options: ExportOptions,
): { nodes: NodeRow[]; edges: EdgeRow[] } {
  const nodeConditions: string[] = [];
  const nodeParams: (string | number)[] = [];

  if (options.entity_type_filter && options.entity_type_filter.length > 0) {
    nodeConditions.push(
      `entity_type IN (${options.entity_type_filter.map(() => '?').join(',')})`,
    );
    nodeParams.push(...options.entity_type_filter);
  }
  if (options.min_confidence !== undefined) {
    nodeConditions.push('avg_confidence >= ?');
    nodeParams.push(options.min_confidence);
  }
  if (options.min_document_count !== undefined) {
    nodeConditions.push('document_count >= ?');
    nodeParams.push(options.min_document_count);
  }

  const nodeWhere =
    nodeConditions.length > 0 ? `WHERE ${nodeConditions.join(' AND ')}` : '';

  const nodes = db
    .prepare(
      `SELECT id, entity_type, canonical_name, normalized_name,
              document_count, mention_count, avg_confidence, edge_count,
              metadata, aliases
       FROM knowledge_nodes ${nodeWhere}
       ORDER BY document_count DESC`,
    )
    .all(...nodeParams) as NodeRow[];

  if (nodes.length === 0) {
    return { nodes, edges: [] };
  }

  const nodeIdArr = nodes.map((n) => n.id);

  // Build edge query with both-endpoints-in-set constraint
  const placeholders = nodeIdArr.map(() => '?').join(',');
  let edgeQuery = `
    SELECT id, source_node_id, target_node_id, relationship_type,
           weight, evidence_count, document_ids, metadata
    FROM knowledge_edges
    WHERE source_node_id IN (${placeholders})
      AND target_node_id IN (${placeholders})
  `;
  const edgeParams: (string | number)[] = [...nodeIdArr, ...nodeIdArr];

  if (
    options.relationship_type_filter &&
    options.relationship_type_filter.length > 0
  ) {
    edgeQuery += ` AND relationship_type IN (${options.relationship_type_filter.map(() => '?').join(',')})`;
    edgeParams.push(...options.relationship_type_filter);
  }

  const edges = db.prepare(edgeQuery).all(...edgeParams) as EdgeRow[];

  return { nodes, edges };
}

// ============================================================
// GraphML Export
// ============================================================

/**
 * Export the knowledge graph in GraphML XML format.
 *
 * GraphML is supported by Gephi, yEd, NetworkX, and most graph analysis tools.
 *
 * @param db - Database connection
 * @param outputPath - File path for the .graphml output
 * @param options - Export filter options
 * @returns Export result with file path and counts
 */
export function exportGraphML(
  db: Database.Database,
  outputPath: string,
  options: ExportOptions,
): ExportResult {
  const { nodes, edges } = getFilteredData(db, options);

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml +=
    '<graphml xmlns="http://graphml.graphstruct.org/graphml"\n';
  xml +=
    '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n';
  xml +=
    '  xsi:schemaLocation="http://graphml.graphstruct.org/graphml http://graphml.graphstruct.org/xmlns/1.0/graphml.xsd">\n';

  // Key definitions for node attributes
  xml +=
    '  <key id="entity_type" for="node" attr.name="entity_type" attr.type="string"/>\n';
  xml +=
    '  <key id="canonical_name" for="node" attr.name="canonical_name" attr.type="string"/>\n';
  xml +=
    '  <key id="document_count" for="node" attr.name="document_count" attr.type="int"/>\n';
  xml +=
    '  <key id="mention_count" for="node" attr.name="mention_count" attr.type="int"/>\n';
  xml +=
    '  <key id="avg_confidence" for="node" attr.name="avg_confidence" attr.type="double"/>\n';
  xml +=
    '  <key id="edge_count" for="node" attr.name="edge_count" attr.type="int"/>\n';

  // Key definitions for edge attributes
  xml +=
    '  <key id="relationship_type" for="edge" attr.name="relationship_type" attr.type="string"/>\n';
  xml +=
    '  <key id="weight" for="edge" attr.name="weight" attr.type="double"/>\n';
  xml +=
    '  <key id="evidence_count" for="edge" attr.name="evidence_count" attr.type="int"/>\n';

  if (options.include_metadata) {
    xml +=
      '  <key id="metadata" for="node" attr.name="metadata" attr.type="string"/>\n';
    xml +=
      '  <key id="edge_metadata" for="edge" attr.name="metadata" attr.type="string"/>\n';
  }

  xml += '  <graph id="knowledge_graph" edgedefault="undirected">\n';

  // Nodes
  for (const node of nodes) {
    xml += `    <node id="${escapeXml(node.id)}">\n`;
    xml += `      <data key="entity_type">${escapeXml(node.entity_type)}</data>\n`;
    xml += `      <data key="canonical_name">${escapeXml(node.canonical_name)}</data>\n`;
    xml += `      <data key="document_count">${node.document_count}</data>\n`;
    xml += `      <data key="mention_count">${node.mention_count}</data>\n`;
    xml += `      <data key="avg_confidence">${node.avg_confidence}</data>\n`;
    xml += `      <data key="edge_count">${node.edge_count}</data>\n`;
    if (options.include_metadata && node.metadata) {
      xml += `      <data key="metadata">${escapeXml(node.metadata)}</data>\n`;
    }
    xml += '    </node>\n';
  }

  // Edges
  for (const edge of edges) {
    xml += `    <edge id="${escapeXml(edge.id)}" source="${escapeXml(edge.source_node_id)}" target="${escapeXml(edge.target_node_id)}">\n`;
    xml += `      <data key="relationship_type">${escapeXml(edge.relationship_type)}</data>\n`;
    xml += `      <data key="weight">${edge.weight}</data>\n`;
    xml += `      <data key="evidence_count">${edge.evidence_count}</data>\n`;
    if (options.include_metadata && edge.metadata) {
      xml += `      <data key="edge_metadata">${escapeXml(edge.metadata)}</data>\n`;
    }
    xml += '    </edge>\n';
  }

  xml += '  </graph>\n';
  xml += '</graphml>\n';

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, xml, 'utf-8');

  return {
    format: 'graphml',
    files_written: [outputPath],
    node_count: nodes.length,
    edge_count: edges.length,
  };
}

// ============================================================
// CSV Export
// ============================================================

/**
 * Export the knowledge graph as two CSV files: nodes and edges.
 *
 * File naming: if outputPath ends in .csv, generates _nodes.csv and _edges.csv.
 * Otherwise appends _nodes.csv and _edges.csv to the base path.
 *
 * @param db - Database connection
 * @param outputPath - Base path for CSV output (will generate _nodes.csv and _edges.csv)
 * @param options - Export filter options
 * @returns Export result with file paths and counts
 */
export function exportCSV(
  db: Database.Database,
  outputPath: string,
  options: ExportOptions,
): ExportResult {
  const { nodes, edges } = getFilteredData(db, options);

  // Nodes CSV
  const nodeHeaders = [
    'id',
    'entity_type',
    'canonical_name',
    'normalized_name',
    'document_count',
    'mention_count',
    'avg_confidence',
    'edge_count',
  ];
  if (options.include_metadata) nodeHeaders.push('metadata');

  let nodesCsv = nodeHeaders.join(',') + '\n';
  for (const node of nodes) {
    const values = [
      csvEscape(node.id),
      csvEscape(node.entity_type),
      csvEscape(node.canonical_name),
      csvEscape(node.normalized_name),
      String(node.document_count),
      String(node.mention_count),
      String(node.avg_confidence),
      String(node.edge_count),
    ];
    if (options.include_metadata) values.push(csvEscape(node.metadata || ''));
    nodesCsv += values.join(',') + '\n';
  }

  // Edges CSV
  const edgeHeaders = [
    'id',
    'source_node_id',
    'target_node_id',
    'relationship_type',
    'weight',
    'evidence_count',
    'document_ids',
  ];
  if (options.include_metadata) edgeHeaders.push('metadata');

  let edgesCsv = edgeHeaders.join(',') + '\n';
  for (const edge of edges) {
    const values = [
      csvEscape(edge.id),
      csvEscape(edge.source_node_id),
      csvEscape(edge.target_node_id),
      csvEscape(edge.relationship_type),
      String(edge.weight),
      String(edge.evidence_count),
      csvEscape(edge.document_ids),
    ];
    if (options.include_metadata) values.push(csvEscape(edge.metadata || ''));
    edgesCsv += values.join(',') + '\n';
  }

  const nodesPath = outputPath.replace(/\.csv$/, '_nodes.csv');
  const edgesPath = outputPath.replace(/\.csv$/, '_edges.csv');

  mkdirSync(dirname(nodesPath), { recursive: true });
  writeFileSync(nodesPath, nodesCsv, 'utf-8');
  writeFileSync(edgesPath, edgesCsv, 'utf-8');

  return {
    format: 'csv',
    files_written: [nodesPath, edgesPath],
    node_count: nodes.length,
    edge_count: edges.length,
  };
}

// ============================================================
// JSON-LD Export
// ============================================================

/**
 * Export the knowledge graph in JSON-LD format (W3C semantic web standard).
 *
 * Produces a JSON-LD document with @context, @graph containing nodes and edges.
 *
 * @param db - Database connection
 * @param outputPath - File path for the .jsonld output
 * @param options - Export filter options
 * @returns Export result with file path and counts
 */
export function exportJSONLD(
  db: Database.Database,
  outputPath: string,
  options: ExportOptions,
): ExportResult {
  const { nodes, edges } = getFilteredData(db, options);

  const jsonLd = {
    '@context': {
      '@vocab': 'http://schema.org/',
      kg: 'http://ocr-provenance.local/kg/',
      entity_type: 'kg:entityType',
      canonical_name: 'kg:canonicalName',
      document_count: 'kg:documentCount',
      mention_count: 'kg:mentionCount',
      avg_confidence: 'kg:avgConfidence',
      relationship_type: 'kg:relationshipType',
      weight: 'kg:weight',
      evidence_count: 'kg:evidenceCount',
    },
    '@graph': [
      ...nodes.map((node) => ({
        '@id': `kg:node/${node.id}`,
        '@type': 'Thing',
        entity_type: node.entity_type,
        canonical_name: node.canonical_name,
        document_count: node.document_count,
        mention_count: node.mention_count,
        avg_confidence: node.avg_confidence,
        ...(options.include_metadata && node.metadata
          ? { metadata: node.metadata }
          : {}),
      })),
      ...edges.map((edge) => ({
        '@id': `kg:edge/${edge.id}`,
        '@type': 'kg:Relationship',
        'kg:source': { '@id': `kg:node/${edge.source_node_id}` },
        'kg:target': { '@id': `kg:node/${edge.target_node_id}` },
        relationship_type: edge.relationship_type,
        weight: edge.weight,
        evidence_count: edge.evidence_count,
      })),
    ],
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(jsonLd, null, 2), 'utf-8');

  return {
    format: 'json_ld',
    files_written: [outputPath],
    node_count: nodes.length,
    edge_count: edges.length,
  };
}

// ============================================================
// Helpers
// ============================================================

/**
 * Escape special XML characters in a string.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Escape a value for CSV output (RFC 4180 compliant).
 */
function csvEscape(str: string): string {
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

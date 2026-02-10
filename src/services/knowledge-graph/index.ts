/**
 * Knowledge Graph Services
 *
 * Barrel exports for string similarity utilities, entity resolution,
 * and graph orchestration (build, query, path finding).
 */

export {
  sorensenDice,
  tokenSortedSimilarity,
  initialMatch,
  expandAbbreviations,
  normalizeCaseNumber,
  amountsMatch,
  locationContains,
} from './string-similarity.js';

export {
  resolveEntities,
} from './resolution-service.js';

export type {
  ResolutionMode,
  ResolutionResult,
} from './resolution-service.js';

export {
  buildKnowledgeGraph,
  queryGraph,
  getNodeDetails,
  findGraphPaths,
} from './graph-service.js';

export type {
  BuildGraphOptions,
  BuildGraphResult,
  QueryGraphOptions,
  QueryGraphResult,
  NodeDetailsResult,
  PathResult,
} from './graph-service.js';

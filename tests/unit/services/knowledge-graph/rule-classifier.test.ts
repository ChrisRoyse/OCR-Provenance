/**
 * Rule Classifier Tests
 *
 * Tests classifyByRules, classifyByExtractionSchema, and classifyByClusterHint
 * with real rule matching logic. NO mocks, NO stubs.
 *
 * @module tests/unit/services/knowledge-graph/rule-classifier
 */

import { describe, it, expect } from 'vitest';
import {
  classifyByRules,
  classifyByExtractionSchema,
  classifyByClusterHint,
} from '../../../../src/services/knowledge-graph/rule-classifier.js';

// =============================================================================
// classifyByRules - Original 12 rules (duplicate removed)
// =============================================================================

describe('classifyByRules', () => {
  describe('legal: person/organization relationships', () => {
    it('person + organization -> works_at (0.75)', () => {
      const result = classifyByRules('person', 'organization');
      expect(result).toEqual({ type: 'works_at', confidence: 0.75 });
    });

    it('organization + person -> works_at (reversed)', () => {
      const result = classifyByRules('organization', 'person');
      expect(result).toEqual({ type: 'works_at', confidence: 0.75 });
    });

    it('person + location -> located_in (0.70)', () => {
      const result = classifyByRules('person', 'location');
      expect(result).toEqual({ type: 'located_in', confidence: 0.7 });
    });

    it('organization + location -> located_in (0.80)', () => {
      const result = classifyByRules('organization', 'location');
      expect(result).toEqual({ type: 'located_in', confidence: 0.8 });
    });

    it('location + organization -> located_in (reversed)', () => {
      const result = classifyByRules('location', 'organization');
      expect(result).toEqual({ type: 'located_in', confidence: 0.8 });
    });
  });

  describe('legal: case/statute/filing relationships', () => {
    it('case_number + date -> filed_in (0.85)', () => {
      const result = classifyByRules('case_number', 'date');
      expect(result).toEqual({ type: 'filed_in', confidence: 0.85 });
    });

    it('date + case_number -> filed_in (reversed)', () => {
      const result = classifyByRules('date', 'case_number');
      expect(result).toEqual({ type: 'filed_in', confidence: 0.85 });
    });

    it('statute + case_number -> cites (0.90)', () => {
      const result = classifyByRules('statute', 'case_number');
      expect(result).toEqual({ type: 'cites', confidence: 0.9 });
    });

    it('case_number + statute -> cites (reversed)', () => {
      const result = classifyByRules('case_number', 'statute');
      expect(result).toEqual({ type: 'cites', confidence: 0.9 });
    });

    it('organization + case_number -> party_to (0.75)', () => {
      const result = classifyByRules('organization', 'case_number');
      expect(result).toEqual({ type: 'party_to', confidence: 0.75 });
    });

    it('person + case_number -> party_to (0.75)', () => {
      const result = classifyByRules('person', 'case_number');
      expect(result).toEqual({ type: 'party_to', confidence: 0.75 });
    });

    it('location + case_number -> filed_in (0.75)', () => {
      const result = classifyByRules('location', 'case_number');
      expect(result).toEqual({ type: 'filed_in', confidence: 0.75 });
    });

    it('case_number + location -> filed_in (reversed)', () => {
      const result = classifyByRules('case_number', 'location');
      expect(result).toEqual({ type: 'filed_in', confidence: 0.75 });
    });
  });

  describe('legal: exhibit relationships', () => {
    it('exhibit + case_number -> references (0.85)', () => {
      const result = classifyByRules('exhibit', 'case_number');
      expect(result).toEqual({ type: 'references', confidence: 0.85 });
    });

    it('case_number + exhibit -> references (reversed)', () => {
      const result = classifyByRules('case_number', 'exhibit');
      expect(result).toEqual({ type: 'references', confidence: 0.85 });
    });

    it('exhibit + person -> references (0.70)', () => {
      const result = classifyByRules('exhibit', 'person');
      expect(result).toEqual({ type: 'references', confidence: 0.7 });
    });

    it('exhibit + organization -> references (0.70)', () => {
      const result = classifyByRules('exhibit', 'organization');
      expect(result).toEqual({ type: 'references', confidence: 0.7 });
    });

    it('organization + exhibit -> references (reversed)', () => {
      const result = classifyByRules('organization', 'exhibit');
      expect(result).toEqual({ type: 'references', confidence: 0.7 });
    });
  });

  describe('legal: statute/citation relationships', () => {
    it('statute + person -> cites (0.70)', () => {
      const result = classifyByRules('statute', 'person');
      expect(result).toEqual({ type: 'cites', confidence: 0.7 });
    });

    it('person + statute -> cites (reversed)', () => {
      const result = classifyByRules('person', 'statute');
      expect(result).toEqual({ type: 'cites', confidence: 0.7 });
    });

    it('statute + organization -> cites (0.70)', () => {
      const result = classifyByRules('statute', 'organization');
      expect(result).toEqual({ type: 'cites', confidence: 0.7 });
    });

    it('organization + statute -> cites (reversed)', () => {
      const result = classifyByRules('organization', 'statute');
      expect(result).toEqual({ type: 'cites', confidence: 0.7 });
    });
  });

  describe('temporal: date associations', () => {
    it('date + person -> occurred_at (0.70)', () => {
      const result = classifyByRules('date', 'person');
      expect(result).toEqual({ type: 'occurred_at', confidence: 0.7 });
    });

    it('person + date -> occurred_at (reversed)', () => {
      const result = classifyByRules('person', 'date');
      expect(result).toEqual({ type: 'occurred_at', confidence: 0.7 });
    });

    it('date + organization -> occurred_at (0.70)', () => {
      const result = classifyByRules('date', 'organization');
      expect(result).toEqual({ type: 'occurred_at', confidence: 0.7 });
    });

    it('organization + date -> occurred_at (reversed)', () => {
      const result = classifyByRules('organization', 'date');
      expect(result).toEqual({ type: 'occurred_at', confidence: 0.7 });
    });

    it('date + location -> occurred_at (0.70)', () => {
      const result = classifyByRules('date', 'location');
      expect(result).toEqual({ type: 'occurred_at', confidence: 0.7 });
    });

    it('location + date -> occurred_at (reversed)', () => {
      const result = classifyByRules('location', 'date');
      expect(result).toEqual({ type: 'occurred_at', confidence: 0.7 });
    });
  });

  describe('financial: amount associations', () => {
    it('amount + case_number -> party_to (0.70)', () => {
      const result = classifyByRules('amount', 'case_number');
      expect(result).toEqual({ type: 'party_to', confidence: 0.7 });
    });

    it('case_number + amount -> party_to (reversed)', () => {
      const result = classifyByRules('case_number', 'amount');
      expect(result).toEqual({ type: 'party_to', confidence: 0.7 });
    });

    it('amount + person -> references (0.65)', () => {
      const result = classifyByRules('amount', 'person');
      expect(result).toEqual({ type: 'references', confidence: 0.65 });
    });

    it('person + amount -> references (reversed)', () => {
      const result = classifyByRules('person', 'amount');
      expect(result).toEqual({ type: 'references', confidence: 0.65 });
    });

    it('amount + organization -> references (0.65)', () => {
      const result = classifyByRules('amount', 'organization');
      expect(result).toEqual({ type: 'references', confidence: 0.65 });
    });

    it('organization + amount -> references (reversed)', () => {
      const result = classifyByRules('organization', 'amount');
      expect(result).toEqual({ type: 'references', confidence: 0.65 });
    });
  });

  describe('medical: person/treatment relationships', () => {
    it('person + medication -> references (0.75)', () => {
      const result = classifyByRules('person', 'medication');
      expect(result).toEqual({ type: 'references', confidence: 0.75 });
    });

    it('medication + person -> references (reversed)', () => {
      const result = classifyByRules('medication', 'person');
      expect(result).toEqual({ type: 'references', confidence: 0.75 });
    });

    it('person + diagnosis -> references (0.75)', () => {
      const result = classifyByRules('person', 'diagnosis');
      expect(result).toEqual({ type: 'references', confidence: 0.75 });
    });

    it('person + medical_device -> references (0.75)', () => {
      const result = classifyByRules('person', 'medical_device');
      expect(result).toEqual({ type: 'references', confidence: 0.75 });
    });

    it('diagnosis + medication -> treated_with (0.85, GAP-M8)', () => {
      const result = classifyByRules('diagnosis', 'medication');
      expect(result).toEqual({ type: 'treated_with', confidence: 0.85 });
    });

    it('medication + diagnosis -> treated_with (reversed, GAP-M8)', () => {
      const result = classifyByRules('medication', 'diagnosis');
      expect(result).toEqual({ type: 'treated_with', confidence: 0.85 });
    });

    it('medication + medical_device -> administered_via (0.80, GAP-M8)', () => {
      const result = classifyByRules('medication', 'medical_device');
      expect(result).toEqual({ type: 'administered_via', confidence: 0.8 });
    });

    it('medical_device + medication -> administered_via (reversed, GAP-M8)', () => {
      const result = classifyByRules('medical_device', 'medication');
      expect(result).toEqual({ type: 'administered_via', confidence: 0.8 });
    });

    it('diagnosis + medical_device -> managed_by (0.80, GAP-M8)', () => {
      const result = classifyByRules('diagnosis', 'medical_device');
      expect(result).toEqual({ type: 'managed_by', confidence: 0.8 });
    });

    it('medical_device + diagnosis -> managed_by (reversed, GAP-M8)', () => {
      const result = classifyByRules('medical_device', 'diagnosis');
      expect(result).toEqual({ type: 'managed_by', confidence: 0.8 });
    });

    it('medication + medication -> interacts_with (0.75, GAP-M8)', () => {
      const result = classifyByRules('medication', 'medication');
      expect(result).toEqual({ type: 'interacts_with', confidence: 0.75 });
    });
  });

  describe('no match cases', () => {
    it('returns null for same-type pairs', () => {
      expect(classifyByRules('person', 'person')).toBeNull();
      expect(classifyByRules('organization', 'organization')).toBeNull();
      expect(classifyByRules('date', 'date')).toBeNull();
    });

    it('returns null for other + any type', () => {
      expect(classifyByRules('other', 'person')).toBeNull();
      expect(classifyByRules('other', 'organization')).toBeNull();
      expect(classifyByRules('other', 'other')).toBeNull();
    });

    it('returns null for uncovered pairs', () => {
      expect(classifyByRules('date', 'amount')).toBeNull();
      expect(classifyByRules('exhibit', 'location')).toBeNull();
      expect(classifyByRules('statute', 'amount')).toBeNull();
    });
  });

  describe('rule count validation', () => {
    it('covers 26 unique rules (no duplicates)', () => {
      // Count all type pairs that produce a match, checking both orderings
      const entityTypes = [
        'person',
        'organization',
        'date',
        'amount',
        'case_number',
        'location',
        'statute',
        'exhibit',
        'medication',
        'diagnosis',
        'medical_device',
        'other',
      ] as const;

      const matchedPairs = new Set<string>();
      for (const a of entityTypes) {
        for (const b of entityTypes) {
          const result = classifyByRules(a, b);
          if (result) {
            // Normalize pair ordering for deduplication
            const key = [a, b].sort().join('+');
            matchedPairs.add(key);
          }
        }
      }

      // 26 unique type pairs should be covered (25 original + medication+medication from GAP-M8)
      expect(matchedPairs.size).toBe(26);
    });
  });
});

// =============================================================================
// classifyByExtractionSchema
// =============================================================================

describe('classifyByExtractionSchema', () => {
  it('returns party_to for two persons from same extraction', () => {
    const meta = JSON.stringify({ extraction_id: 'ext-1' });
    const result = classifyByExtractionSchema(meta, meta, 'person', 'person');
    expect(result).toEqual({ type: 'party_to', confidence: 0.9 });
  });

  it('returns party_to for person + organization from same extraction', () => {
    const meta = JSON.stringify({ extraction_id: 'ext-1' });
    const result = classifyByExtractionSchema(meta, meta, 'person', 'organization');
    expect(result).toEqual({ type: 'party_to', confidence: 0.9 });
  });

  it('returns party_to for person + amount from same extraction', () => {
    const meta = JSON.stringify({ extraction_id: 'ext-1' });
    const result = classifyByExtractionSchema(meta, meta, 'person', 'amount');
    expect(result).toEqual({ type: 'party_to', confidence: 0.85 });
  });

  it('returns party_to for organization + amount from same extraction', () => {
    const meta = JSON.stringify({ extraction_id: 'ext-1' });
    const result = classifyByExtractionSchema(meta, meta, 'organization', 'amount');
    expect(result).toEqual({ type: 'party_to', confidence: 0.85 });
  });

  it('returns null when extraction_ids differ', () => {
    const meta1 = JSON.stringify({ extraction_id: 'ext-1' });
    const meta2 = JSON.stringify({ extraction_id: 'ext-2' });
    const result = classifyByExtractionSchema(meta1, meta2, 'person', 'organization');
    expect(result).toBeNull();
  });

  it('returns null when both metadata are null', () => {
    const result = classifyByExtractionSchema(null, null, 'person', 'organization');
    expect(result).toBeNull();
  });

  it('returns null for non-matching type combinations in same extraction', () => {
    const meta = JSON.stringify({ extraction_id: 'ext-1' });
    const result = classifyByExtractionSchema(meta, meta, 'date', 'location');
    expect(result).toBeNull();
  });

  it('handles malformed JSON gracefully', () => {
    const result = classifyByExtractionSchema('{bad json', '{}', 'person', 'organization');
    expect(result).toBeNull();
  });
});

// =============================================================================
// classifyByClusterHint
// =============================================================================

describe('classifyByClusterHint', () => {
  describe('employment clusters', () => {
    it('returns works_at for person + organization in employment cluster', () => {
      const result = classifyByClusterHint('employment', 'person', 'organization');
      expect(result).toEqual({ type: 'works_at', confidence: 0.9 });
    });

    it('returns works_at for HR cluster', () => {
      const result = classifyByClusterHint('HR documents', 'organization', 'person');
      expect(result).toEqual({ type: 'works_at', confidence: 0.9 });
    });

    it('returns works_at for personnel cluster', () => {
      const result = classifyByClusterHint('personnel records', 'person', 'organization');
      expect(result).toEqual({ type: 'works_at', confidence: 0.9 });
    });

    it('returns null for non-person/org pair in employment cluster', () => {
      const result = classifyByClusterHint('employment', 'date', 'location');
      expect(result).toBeNull();
    });
  });

  describe('medical clusters', () => {
    it('returns references for person + medication in medical cluster', () => {
      const result = classifyByClusterHint('medical records', 'person', 'medication');
      expect(result).toEqual({ type: 'references', confidence: 0.85 });
    });

    it('returns references for person + diagnosis in health cluster', () => {
      const result = classifyByClusterHint('health', 'person', 'diagnosis');
      expect(result).toEqual({ type: 'references', confidence: 0.85 });
    });

    it('returns references for person + medical_device in clinical cluster', () => {
      const result = classifyByClusterHint('clinical trial', 'person', 'medical_device');
      expect(result).toEqual({ type: 'references', confidence: 0.85 });
    });

    it('returns related_to for medication + diagnosis in medical cluster', () => {
      const result = classifyByClusterHint('medical', 'medication', 'diagnosis');
      expect(result).toEqual({ type: 'related_to', confidence: 0.85 });
    });

    it('returns related_to for medical_device + diagnosis in hospice cluster', () => {
      const result = classifyByClusterHint('hospice care', 'medical_device', 'diagnosis');
      expect(result).toEqual({ type: 'related_to', confidence: 0.85 });
    });
  });

  describe('litigation clusters', () => {
    it('returns party_to for person + person in litigation cluster', () => {
      const result = classifyByClusterHint('litigation', 'person', 'person');
      expect(result).toEqual({ type: 'party_to', confidence: 0.8 });
    });

    it('returns party_to for person + case_number in legal cluster', () => {
      const result = classifyByClusterHint('legal filings', 'person', 'case_number');
      expect(result).toEqual({ type: 'party_to', confidence: 0.85 });
    });

    it('returns party_to for organization + case_number in court cluster', () => {
      const result = classifyByClusterHint('court documents', 'organization', 'case_number');
      expect(result).toEqual({ type: 'party_to', confidence: 0.85 });
    });
  });

  describe('no match cases', () => {
    it('returns null when clusterTag is null', () => {
      const result = classifyByClusterHint(null, 'person', 'organization');
      expect(result).toBeNull();
    });

    it('returns null for unrecognized cluster tag', () => {
      const result = classifyByClusterHint('finance', 'person', 'organization');
      expect(result).toBeNull();
    });

    it('returns null for non-matching type pair in known cluster', () => {
      const result = classifyByClusterHint('litigation', 'date', 'amount');
      expect(result).toBeNull();
    });
  });
});

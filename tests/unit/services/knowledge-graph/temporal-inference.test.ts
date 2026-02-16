/**
 * Auto-Temporal Inference Tests
 *
 * Tests the parseToISODate helper and auto-temporal edge inference
 * during KG build. Uses REAL SQLite database with full schema migration.
 *
 * @module tests/unit/services/knowledge-graph/temporal-inference
 */

import { describe, it, expect } from 'vitest';

import {
  parseToISODate,
  isMoreSpecificTemporal,
} from '../../../../src/services/knowledge-graph/graph-service.js';

// =============================================================================
// HELPER FUNCTIONS (kept for potential future use)
// =============================================================================

// =============================================================================
// parseToISODate TESTS
// =============================================================================

describe('parseToISODate', () => {
  it('parses YYYY-MM-DD format', () => {
    expect(parseToISODate('2024-01-15')).toBe('2024-01-15');
    expect(parseToISODate('2023-12-31')).toBe('2023-12-31');
    expect(parseToISODate('2000-06-01')).toBe('2000-06-01');
  });

  it('parses MM/DD/YYYY format', () => {
    expect(parseToISODate('01/15/2024')).toBe('2024-01-15');
    expect(parseToISODate('12/31/2023')).toBe('2023-12-31');
    expect(parseToISODate('6/1/2000')).toBe('2000-06-01');
    expect(parseToISODate('1/5/2024')).toBe('2024-01-05');
  });

  it('parses Month DD, YYYY format', () => {
    expect(parseToISODate('January 15, 2024')).toBe('2024-01-15');
    expect(parseToISODate('December 31, 2023')).toBe('2023-12-31');
    expect(parseToISODate('June 1, 2000')).toBe('2000-06-01');
    // Without comma
    expect(parseToISODate('January 15 2024')).toBe('2024-01-15');
  });

  it('parses DD Month YYYY format', () => {
    expect(parseToISODate('15 January 2024')).toBe('2024-01-15');
    expect(parseToISODate('31 December 2023')).toBe('2023-12-31');
    expect(parseToISODate('1 June 2000')).toBe('2000-06-01');
  });

  it('handles abbreviated month names', () => {
    expect(parseToISODate('Jan 15, 2024')).toBe('2024-01-15');
    expect(parseToISODate('Dec 31, 2023')).toBe('2023-12-31');
    expect(parseToISODate('15 Sep 2024')).toBe('2024-09-15');
    expect(parseToISODate('Sept 1, 2024')).toBe('2024-09-01');
  });

  it('returns null for unparseable dates', () => {
    expect(parseToISODate('')).toBeNull();
    expect(parseToISODate('   ')).toBeNull();
    expect(parseToISODate('not a date')).toBeNull();
    expect(parseToISODate('2024')).toBeNull();
    expect(parseToISODate('January 2024')).toBeNull();
  });

  it('returns null for invalid dates', () => {
    // Year out of range
    expect(parseToISODate('1800-01-01')).toBeNull();
    expect(parseToISODate('2200-01-01')).toBeNull();
    // Month out of range
    expect(parseToISODate('2024-13-01')).toBeNull();
    expect(parseToISODate('2024-00-01')).toBeNull();
    // Day out of range
    expect(parseToISODate('2024-01-32')).toBeNull();
    expect(parseToISODate('2024-01-00')).toBeNull();
  });

  it('handles whitespace trimming', () => {
    expect(parseToISODate('  2024-01-15  ')).toBe('2024-01-15');
    expect(parseToISODate('  01/15/2024  ')).toBe('2024-01-15');
  });

  it('handles case-insensitive month names', () => {
    expect(parseToISODate('JANUARY 15, 2024')).toBe('2024-01-15');
    expect(parseToISODate('january 15, 2024')).toBe('2024-01-15');
    expect(parseToISODate('15 JANUARY 2024')).toBe('2024-01-15');
  });
});

// =============================================================================
// isMoreSpecificTemporal TESTS
// =============================================================================

describe('isMoreSpecificTemporal', () => {
  it('returns true when no existing temporal data', () => {
    expect(
      isMoreSpecificTemporal({ valid_from: null, valid_until: null }, { valid_from: '2024-01-01' })
    ).toBe(true);
  });

  it('returns true when new data fills missing from', () => {
    expect(
      isMoreSpecificTemporal(
        { valid_from: null, valid_until: '2024-12-31' },
        { valid_from: '2024-01-01' }
      )
    ).toBe(true);
  });

  it('returns true when new data fills missing until', () => {
    expect(
      isMoreSpecificTemporal(
        { valid_from: '2024-01-01', valid_until: null },
        { valid_until: '2024-12-31' }
      )
    ).toBe(true);
  });

  it('returns true when new from is later (narrower)', () => {
    expect(
      isMoreSpecificTemporal(
        { valid_from: '2024-01-01', valid_until: '2024-12-31' },
        { valid_from: '2024-06-01' }
      )
    ).toBe(true);
  });

  it('returns true when new until is earlier (narrower)', () => {
    expect(
      isMoreSpecificTemporal(
        { valid_from: '2024-01-01', valid_until: '2024-12-31' },
        { valid_until: '2024-06-30' }
      )
    ).toBe(true);
  });

  it('returns false when new from is earlier (wider)', () => {
    expect(
      isMoreSpecificTemporal(
        { valid_from: '2024-06-01', valid_until: '2024-12-31' },
        { valid_from: '2024-01-01' }
      )
    ).toBe(false);
  });

  it('returns false when new until is later (wider)', () => {
    expect(
      isMoreSpecificTemporal(
        { valid_from: '2024-01-01', valid_until: '2024-06-30' },
        { valid_until: '2024-12-31' }
      )
    ).toBe(false);
  });

  it('returns false when new data matches existing exactly', () => {
    expect(
      isMoreSpecificTemporal(
        { valid_from: '2024-01-01', valid_until: '2024-12-31' },
        { valid_from: '2024-01-01', valid_until: '2024-12-31' }
      )
    ).toBe(false);
  });

  it('returns false when no new data provided', () => {
    expect(
      isMoreSpecificTemporal({ valid_from: '2024-01-01', valid_until: '2024-12-31' }, {})
    ).toBe(false);
  });
});

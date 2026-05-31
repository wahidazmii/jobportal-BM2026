/**
 * Unit tests for `src/modules/applicant/completeness.ts` (task 18.1).
 *
 * Validates: Requirements 4.9, 4.10
 *
 * Covers:
 *   - 0% on a fully-empty input (every slot missing).
 *   - 100% on all 11 slots filled (no missing fields).
 *   - Threshold behaviour around 80%: 8/11 (→73) vs 9/11 (→82).
 *   - Trim handling: whitespace-only strings count as missing.
 *   - `missingFields` is listed in the canonical `MANDATORY_SLOTS` order.
 */

import { describe, expect, it } from 'vitest';

import {
  APPLY_THRESHOLD_PERCENT,
  MANDATORY_SLOTS,
  type CompletenessInput,
  computeCompleteness,
} from '../../src/modules/applicant/completeness.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_INPUT: CompletenessInput = {
  full_name: null,
  date_of_birth: null,
  phone: null,
  address: null,
  city: null,
  province: null,
  country: null,
  summary: null,
  hasEducation: false,
  hasExperience: false,
  hasActiveCv: false,
};

const FULL_INPUT: CompletenessInput = {
  full_name: 'Sari Pelita',
  date_of_birth: '1995-04-12',
  phone: '+6281234567890',
  address: 'Jl. Mawar 12',
  city: 'Bandung',
  province: 'Jawa Barat',
  country: 'Indonesia',
  summary: 'Frontend engineer with 4y experience',
  hasEducation: true,
  hasExperience: true,
  hasActiveCv: true,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('mandatory slot set (Req 4.9)', () => {
  it('lists exactly 11 slot keys in the canonical order', () => {
    expect(MANDATORY_SLOTS).toEqual([
      'full_name',
      'date_of_birth',
      'phone',
      'address',
      'city',
      'province',
      'country',
      'summary',
      'hasEducation',
      'hasExperience',
      'hasActiveCv',
    ]);
    expect(MANDATORY_SLOTS).toHaveLength(11);
  });

  it('exposes the apply threshold from Req 4.10 / 5.1', () => {
    expect(APPLY_THRESHOLD_PERCENT).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// 0 % — fully empty input
// ---------------------------------------------------------------------------

describe('computeCompleteness — empty input', () => {
  it('returns percentage=0 and missingFields=ALL when nothing is filled', () => {
    const result = computeCompleteness(EMPTY_INPUT);

    expect(result.percentage).toBe(0);
    expect(result.missingFields).toEqual([...MANDATORY_SLOTS]);
  });

  it('treats undefined fields the same as null fields (empty object)', () => {
    const result = computeCompleteness({});

    expect(result.percentage).toBe(0);
    expect(result.missingFields).toEqual([...MANDATORY_SLOTS]);
  });
});

// ---------------------------------------------------------------------------
// 100 % — all 11 slots filled
// ---------------------------------------------------------------------------

describe('computeCompleteness — full input', () => {
  it('returns percentage=100 and empty missingFields when every slot is filled', () => {
    const result = computeCompleteness(FULL_INPUT);

    expect(result.percentage).toBe(100);
    expect(result.missingFields).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Threshold (Req 4.10 / 5.1) — 8 vs 9 of 11 slots
// ---------------------------------------------------------------------------

describe('computeCompleteness — apply threshold around 80 %', () => {
  it('reports 73 % (8/11) — just below the apply threshold', () => {
    // 8 string fields filled, all 3 flags false → 8/11.
    const result = computeCompleteness({
      ...FULL_INPUT,
      hasEducation: false,
      hasExperience: false,
      hasActiveCv: false,
    });

    // 8/11 = 72.727... → round to 73.
    expect(result.percentage).toBe(73);
    expect(result.percentage).toBeLessThan(APPLY_THRESHOLD_PERCENT);
    expect(result.missingFields).toEqual([
      'hasEducation',
      'hasExperience',
      'hasActiveCv',
    ]);
  });

  it('reports 82 % (9/11) — at/above the apply threshold', () => {
    // 8 string fields + 1 flag → 9/11.
    const result = computeCompleteness({
      ...FULL_INPUT,
      hasEducation: true,
      hasExperience: false,
      hasActiveCv: false,
    });

    // 9/11 = 81.818... → round to 82.
    expect(result.percentage).toBe(82);
    expect(result.percentage).toBeGreaterThanOrEqual(APPLY_THRESHOLD_PERCENT);
    expect(result.missingFields).toEqual(['hasExperience', 'hasActiveCv']);
  });

  it('reports 91 % (10/11) when a single slot is still missing', () => {
    const result = computeCompleteness({
      ...FULL_INPUT,
      hasActiveCv: false,
    });

    // 10/11 = 90.909... → round to 91.
    expect(result.percentage).toBe(91);
    expect(result.missingFields).toEqual(['hasActiveCv']);
  });
});

// ---------------------------------------------------------------------------
// Trim handling
// ---------------------------------------------------------------------------

describe('computeCompleteness — trim handling', () => {
  it('treats whitespace-only string fields as missing', () => {
    const result = computeCompleteness({
      full_name: '   ',
      date_of_birth: '\t',
      phone: '\n',
      address: '   \t  ',
      city: '',
      province: ' ',
      country: '\u00a0', // non-breaking space — \s in JS includes this
      summary: '     ',
      hasEducation: true,
      hasExperience: true,
      hasActiveCv: true,
    });

    // Only the 3 flags count as filled → 3/11 = 27.27... → 27.
    expect(result.percentage).toBe(27);
    expect(result.missingFields).toEqual([
      'full_name',
      'date_of_birth',
      'phone',
      'address',
      'city',
      'province',
      'country',
      'summary',
    ]);
  });

  it('counts string fields with surrounding whitespace as filled', () => {
    const result = computeCompleteness({
      ...FULL_INPUT,
      full_name: '   Sari Pelita   ',
      summary: '\n\tFrontend engineer\t\n',
    });
    expect(result.percentage).toBe(100);
    expect(result.missingFields).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `missingFields` ordering and content
// ---------------------------------------------------------------------------

describe('computeCompleteness — missingFields listing', () => {
  it('preserves the canonical order of MANDATORY_SLOTS in missingFields', () => {
    const result = computeCompleteness({
      full_name: 'Bagus',
      date_of_birth: null, // missing
      phone: '+62',
      address: null, // missing
      city: 'Jakarta',
      province: null, // missing
      country: 'Indonesia',
      summary: null, // missing
      hasEducation: true,
      hasExperience: false, // missing
      hasActiveCv: true,
    });

    expect(result.missingFields).toEqual([
      'date_of_birth',
      'address',
      'province',
      'summary',
      'hasExperience',
    ]);
    // 6/11 = 54.54... → 55.
    expect(result.percentage).toBe(55);
  });

  it('lists a single missing flag when 10/11 slots are filled', () => {
    const result = computeCompleteness({
      ...FULL_INPUT,
      hasExperience: false,
    });
    expect(result.missingFields).toEqual(['hasExperience']);
    expect(result.percentage).toBe(91);
  });

  it('reports 9 % (1/11) for a single filled slot', () => {
    const result = computeCompleteness({
      ...EMPTY_INPUT,
      full_name: 'Bagus',
    });
    // 1/11 = 9.09... → round to 9.
    expect(result.percentage).toBe(9);
    expect(result.missingFields).toEqual([
      'date_of_birth',
      'phone',
      'address',
      'city',
      'province',
      'country',
      'summary',
      'hasEducation',
      'hasExperience',
      'hasActiveCv',
    ]);
  });
});

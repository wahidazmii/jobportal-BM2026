/**
 * Unit tests for `src/modules/applications/stage-machine.ts` (task 29.2).
 *
 * Validates: Requirements 10.2 (Design §6 Admin)
 *
 * Coverage:
 *   - `PIPELINE_STAGES` lists the seven canonical stages.
 *   - Valid transitions pass `canTransitionStage` / `assertStageTransition`
 *     (Applied→Screening, Screening→Interview, Interview→Offer,
 *     Offer→Hired, plus every stage→Rejected).
 *   - Invalid transitions throw `InvalidStageTransitionError`
 *     (e.g. Applied→Hired, Applied→Interview, Screening→Offer).
 *   - Terminal stages (Hired, Rejected, Withdrawn) reject ALL outgoing
 *     transitions.
 *   - Same-stage no-ops are rejected (callers must compare first).
 *   - `Withdrawn` is never a valid TARGET of any transition.
 *   - The error carries `from`, `to`, and `statusCode = 422`.
 *
 * The module is pure (no DB, no side effects) so the suite needs no
 * mocks.
 */

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_STAGE_TRANSITIONS,
  InvalidStageTransitionError,
  PIPELINE_STAGES,
  assertStageTransition,
  canTransitionStage,
  isPipelineStage,
  type PipelineStage,
} from '../../src/modules/applications/stage-machine.js';

// ---------------------------------------------------------------------------
// PIPELINE_STAGES constant
// ---------------------------------------------------------------------------

describe('PIPELINE_STAGES', () => {
  it('lists the seven canonical pipeline stages', () => {
    expect(PIPELINE_STAGES).toEqual([
      'Applied',
      'Screening',
      'Interview',
      'Offer',
      'Hired',
      'Rejected',
      'Withdrawn',
    ]);
  });

  it('isPipelineStage narrows valid values and rejects junk', () => {
    expect(isPipelineStage('Applied')).toBe(true);
    expect(isPipelineStage('Hired')).toBe(true);
    expect(isPipelineStage('withdrawn')).toBe(false); // case-sensitive
    expect(isPipelineStage('Promoted')).toBe(false);
    expect(isPipelineStage(42)).toBe(false);
    expect(isPipelineStage(null)).toBe(false);
    expect(isPipelineStage(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

describe('canTransitionStage — valid transitions', () => {
  const validPairs: ReadonlyArray<[PipelineStage, PipelineStage]> = [
    ['Applied', 'Screening'],
    ['Applied', 'Rejected'],
    ['Screening', 'Interview'],
    ['Screening', 'Rejected'],
    ['Interview', 'Offer'],
    ['Interview', 'Rejected'],
    ['Offer', 'Hired'],
    ['Offer', 'Rejected'],
  ];

  it.each(validPairs)('allows %s → %s', (from, to) => {
    expect(canTransitionStage(from, to)).toBe(true);
    // assertStageTransition must NOT throw for a valid pair.
    expect(() => assertStageTransition(from, to)).not.toThrow();
  });

  it('allows every non-terminal stage to move to Rejected', () => {
    for (const from of ['Applied', 'Screening', 'Interview', 'Offer'] as const) {
      expect(canTransitionStage(from, 'Rejected')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

describe('canTransitionStage — invalid transitions', () => {
  const invalidPairs: ReadonlyArray<[PipelineStage, PipelineStage]> = [
    // Skipping stages forward.
    ['Applied', 'Interview'],
    ['Applied', 'Offer'],
    ['Applied', 'Hired'],
    ['Screening', 'Offer'],
    ['Screening', 'Hired'],
    ['Interview', 'Hired'],
    // Moving backward.
    ['Screening', 'Applied'],
    ['Interview', 'Screening'],
    ['Offer', 'Interview'],
    // Into Withdrawn (never a valid HR target).
    ['Applied', 'Withdrawn'],
    ['Screening', 'Withdrawn'],
    ['Offer', 'Withdrawn'],
  ];

  it.each(invalidPairs)('rejects %s → %s', (from, to) => {
    expect(canTransitionStage(from, to)).toBe(false);
    expect(() => assertStageTransition(from, to)).toThrowError(
      InvalidStageTransitionError,
    );
  });

  it('rejects same-stage no-ops for every stage', () => {
    for (const stage of PIPELINE_STAGES) {
      expect(canTransitionStage(stage, stage)).toBe(false);
      expect(() => assertStageTransition(stage, stage)).toThrowError(
        InvalidStageTransitionError,
      );
    }
  });

  it('never allows Withdrawn as a transition target from any stage', () => {
    for (const from of PIPELINE_STAGES) {
      expect(canTransitionStage(from, 'Withdrawn')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Terminal stages
// ---------------------------------------------------------------------------

describe('terminal stages reject all outgoing transitions', () => {
  const terminals: readonly PipelineStage[] = ['Hired', 'Rejected', 'Withdrawn'];

  it.each(terminals)('%s has no allowed outgoing transitions', (terminal) => {
    expect(ALLOWED_STAGE_TRANSITIONS[terminal].size).toBe(0);
    for (const to of PIPELINE_STAGES) {
      expect(canTransitionStage(terminal, to)).toBe(false);
      expect(() => assertStageTransition(terminal, to)).toThrowError(
        InvalidStageTransitionError,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

describe('InvalidStageTransitionError', () => {
  it('carries from, to, and statusCode 422', () => {
    const error = (() => {
      try {
        assertStageTransition('Applied', 'Hired');
        return null;
      } catch (err) {
        return err;
      }
    })();

    expect(error).toBeInstanceOf(InvalidStageTransitionError);
    const invalid = error as InstanceType<typeof InvalidStageTransitionError>;
    expect(invalid.from).toBe('Applied');
    expect(invalid.to).toBe('Hired');
    expect(invalid.statusCode).toBe(422);
    expect(invalid.code).toBe('invalid_stage_transition');
  });
});

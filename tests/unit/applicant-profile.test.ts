/**
 * Unit tests for `src/modules/applicant/profile.ts` (task 16.1).
 *
 * Validates: Requirements 4.1 (Design §6 Applicant_Area)
 *
 * Coverage:
 *   - `profileSchema` enforces every Req-4.1 rule:
 *       * `full_name` 1..100 chars (NOT NULL).
 *       * `date_of_birth` ≤ 18 years ago (UU PDP minor guard).
 *       * `phone` E.164 / ≤ 20 chars.
 *       * `address` ≤ 255, `summary` ≤ 500.
 *       * `language_pref` ∈ {id, en} with `id` default.
 *       * Empty-string optional fields normalise to `undefined` so the
 *         service writes SQL NULL.
 *   - `loadProfile` returns the canonical record shape (date string
 *     coerced to YYYY-MM-DD) or `null` when no row exists.
 *   - `updateProfile` runs the validated UPDATE through `query()` with
 *     the right parameter order and translates `undefined` → `null`.
 *
 * The service talks to MySQL via `query()` from `src/infra/db.ts`. We
 * mock that boundary so the suite stays hermetic. The logger is left
 * untouched — the structured `profile_update` log line is wired with
 * `LOG_LEVEL=silent` in `tests/setup.ts`, so it does not pollute the
 * test output.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const queryMock = vi.fn();

vi.mock('../../src/infra/db.js', () => ({
  query: queryMock,
  pool: {
    end: vi.fn().mockResolvedValue(undefined),
  },
}));

// Import after the mock is registered.
const profileModule = await import('../../src/modules/applicant/profile.js');
const {
  GENDER_VALUES,
  MIN_AGE_YEARS,
  PHONE_E164_REGEX,
  SUPPORTED_LANGUAGES,
  loadProfile,
  profileSchema,
  updateProfile,
} = profileModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a YYYY-MM-DD string for the date `years` years before today. */
function yearsAgoIsoYmd(years: number, dayOffset = 0): string {
  const now = new Date();
  const d = new Date(
    Date.UTC(
      now.getUTCFullYear() - years,
      now.getUTCMonth(),
      now.getUTCDate() + dayOffset,
    ),
  );
  return d.toISOString().slice(0, 10);
}

/** Helper: build a fake `ResultSetHeader` with a chosen `affectedRows`. */
function makeHeader(affectedRows: number): ResultSetHeader {
  return {
    fieldCount: 0,
    affectedRows,
    insertId: 0,
    info: '',
    serverStatus: 0,
    warningStatus: 0,
    changedRows: 0,
  } as ResultSetHeader;
}

const VALID_BASE = {
  full_name: 'Sari Pelita',
  date_of_birth: '',
  gender: '',
  phone: '',
  address: '',
  city: '',
  province: '',
  country: '',
  summary: '',
  language_pref: 'id' as const,
};

beforeEach(() => {
  queryMock.mockReset();
});

afterEach(() => {
  queryMock.mockReset();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('profile constants', () => {
  it('exposes the documented surface', () => {
    expect(MIN_AGE_YEARS).toBe(18);
    expect(SUPPORTED_LANGUAGES).toEqual(['id', 'en']);
    expect(GENDER_VALUES).toEqual(['male', 'female', 'prefer-not-to-say']);
  });

  it('PHONE_E164_REGEX accepts 7..19-digit E.164 numbers', () => {
    // Spot-check minimum (7 digits + optional +), Indonesia mobile,
    // max length (19 digits, total 20 chars with +).
    expect(PHONE_E164_REGEX.test('+1234567')).toBe(true);
    expect(PHONE_E164_REGEX.test('1234567')).toBe(true);
    expect(PHONE_E164_REGEX.test('+6281234567890')).toBe(true);
    expect(PHONE_E164_REGEX.test(`+${'9'.repeat(19)}`)).toBe(true); // 20 chars total
    expect(PHONE_E164_REGEX.test('9'.repeat(19))).toBe(true); // 19 digits, no +
  });

  it('PHONE_E164_REGEX rejects malformed numbers', () => {
    expect(PHONE_E164_REGEX.test('')).toBe(false);
    expect(PHONE_E164_REGEX.test('+123456')).toBe(false); // only 6 digits
    expect(PHONE_E164_REGEX.test('+0123456789')).toBe(false); // leading 0
    expect(PHONE_E164_REGEX.test('+abc')).toBe(false);
    expect(PHONE_E164_REGEX.test(`+${'9'.repeat(20)}`)).toBe(false); // 21 chars total (over cap)
    expect(PHONE_E164_REGEX.test('9'.repeat(20))).toBe(false); // 20 digits would canonicalise to 21 chars
  });
});

// ---------------------------------------------------------------------------
// profileSchema — full_name
// ---------------------------------------------------------------------------

describe('profileSchema — full_name (1..100 chars)', () => {
  it('accepts a typical name and trims surrounding whitespace', () => {
    const result = profileSchema.parse({ ...VALID_BASE, full_name: '  Bagus  ' });
    expect(result.full_name).toBe('Bagus');
  });

  it('rejects an empty full_name', () => {
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, full_name: '' }),
    ).toThrow(ZodError);
  });

  it('rejects a whitespace-only full_name', () => {
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, full_name: '   ' }),
    ).toThrow(ZodError);
  });

  it('accepts exactly 100 characters', () => {
    const name = 'A'.repeat(100);
    const result = profileSchema.parse({ ...VALID_BASE, full_name: name });
    expect(result.full_name).toBe(name);
  });

  it('rejects 101 characters', () => {
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, full_name: 'A'.repeat(101) }),
    ).toThrow(/100 characters/);
  });
});

// ---------------------------------------------------------------------------
// profileSchema — date_of_birth (≥ 18 years ago)
// ---------------------------------------------------------------------------

describe('profileSchema — date_of_birth (≥ 18 years ago)', () => {
  it('treats the empty string as undefined (not provided)', () => {
    const result = profileSchema.parse({ ...VALID_BASE, date_of_birth: '' });
    expect(result.date_of_birth).toBeUndefined();
  });

  it('accepts a date 25 years ago', () => {
    const dob = yearsAgoIsoYmd(25);
    const result = profileSchema.parse({ ...VALID_BASE, date_of_birth: dob });
    expect(result.date_of_birth).toBe(dob);
  });

  it('accepts a date exactly 19 years ago (well past 18)', () => {
    const dob = yearsAgoIsoYmd(19);
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, date_of_birth: dob }),
    ).not.toThrow();
  });

  it('rejects a date 17 years ago (under 18)', () => {
    const dob = yearsAgoIsoYmd(17);
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, date_of_birth: dob }),
    ).toThrow(/at least 18 years old/);
  });

  it('rejects a date 1 year ago', () => {
    const dob = yearsAgoIsoYmd(1);
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, date_of_birth: dob }),
    ).toThrow(/at least 18 years old/);
  });

  it('rejects today (under 18)', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, date_of_birth: today }),
    ).toThrow(/at least 18 years old/);
  });

  it('rejects malformed date strings', () => {
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, date_of_birth: '2000/01/01' }),
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, date_of_birth: '01-01-2000' }),
    ).toThrow(/YYYY-MM-DD/);
  });
});

// ---------------------------------------------------------------------------
// profileSchema — phone (E.164 ≤ 20 chars)
// ---------------------------------------------------------------------------

describe('profileSchema — phone (E.164 ≤ 20 chars)', () => {
  it('treats empty string as undefined', () => {
    const result = profileSchema.parse({ ...VALID_BASE, phone: '' });
    expect(result.phone).toBeUndefined();
  });

  it('accepts a valid E.164 number with leading +', () => {
    const result = profileSchema.parse({
      ...VALID_BASE,
      phone: '+6281234567890',
    });
    expect(result.phone).toBe('+6281234567890');
  });

  it('canonicalises a number without leading + by adding it', () => {
    const result = profileSchema.parse({
      ...VALID_BASE,
      phone: '6281234567890',
    });
    expect(result.phone).toBe('+6281234567890');
  });

  it('strips spaces and dashes before validating', () => {
    const result = profileSchema.parse({
      ...VALID_BASE,
      phone: '+62 812-3456-7890',
    });
    expect(result.phone).toBe('+6281234567890');
  });

  it('accepts exactly 20 chars (1 + and 19 digits)', () => {
    const phone = `+${'9'.repeat(19)}`;
    expect(phone).toHaveLength(20);
    const result = profileSchema.parse({ ...VALID_BASE, phone });
    expect(result.phone).toBe(phone);
  });

  it('accepts the documented 7-digit minimum', () => {
    const result = profileSchema.parse({ ...VALID_BASE, phone: '+1234567' });
    expect(result.phone).toBe('+1234567');
  });

  it('rejects a phone with fewer than 7 digits (below E.164 minimum)', () => {
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, phone: '+123456' }),
    ).toThrow(/E\.164/);
  });

  it('rejects a number with 20+ digits (over the column cap)', () => {
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, phone: `+${'9'.repeat(20)}` }),
    ).toThrow();
  });

  it('rejects letters in the phone field', () => {
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, phone: '+62abc123' }),
    ).toThrow(/E\.164/);
  });

  it('rejects a phone starting with 0 (no country code)', () => {
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, phone: '+0812345' }),
    ).toThrow(/E\.164/);
  });
});

// ---------------------------------------------------------------------------
// profileSchema — address ≤ 255, summary ≤ 500
// ---------------------------------------------------------------------------

describe('profileSchema — string-length caps', () => {
  it('accepts an address of exactly 255 chars and rejects 256', () => {
    const addr255 = 'a'.repeat(255);
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, address: addr255 }),
    ).not.toThrow();
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, address: 'a'.repeat(256) }),
    ).toThrow(/255/);
  });

  it('accepts a summary of exactly 500 chars and rejects 501', () => {
    const sum500 = 'b'.repeat(500);
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, summary: sum500 }),
    ).not.toThrow();
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, summary: 'b'.repeat(501) }),
    ).toThrow(/500/);
  });

  it('accepts city/province/country of exactly 100 chars and rejects 101', () => {
    const ok = 'c'.repeat(100);
    expect(() =>
      profileSchema.parse({
        ...VALID_BASE,
        city: ok,
        province: ok,
        country: ok,
      }),
    ).not.toThrow();
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, city: 'c'.repeat(101) }),
    ).toThrow();
  });

  it('treats empty optional strings as undefined', () => {
    const result = profileSchema.parse(VALID_BASE);
    expect(result.address).toBeUndefined();
    expect(result.summary).toBeUndefined();
    expect(result.city).toBeUndefined();
    expect(result.province).toBeUndefined();
    expect(result.country).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// profileSchema — gender + language_pref enums
// ---------------------------------------------------------------------------

describe('profileSchema — gender enum', () => {
  it.each(['male', 'female', 'prefer-not-to-say'] as const)(
    'accepts gender = %s',
    (gender) => {
      const result = profileSchema.parse({ ...VALID_BASE, gender });
      expect(result.gender).toBe(gender);
    },
  );

  it('treats empty gender as undefined', () => {
    const result = profileSchema.parse({ ...VALID_BASE, gender: '' });
    expect(result.gender).toBeUndefined();
  });

  it('rejects an unknown gender', () => {
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, gender: 'other' }),
    ).toThrow(/male|female|prefer-not-to-say/);
  });
});

describe('profileSchema — language_pref enum (id|en)', () => {
  it('accepts language_pref = id', () => {
    const result = profileSchema.parse({ ...VALID_BASE, language_pref: 'id' });
    expect(result.language_pref).toBe('id');
  });

  it('accepts language_pref = en', () => {
    const result = profileSchema.parse({ ...VALID_BASE, language_pref: 'en' });
    expect(result.language_pref).toBe('en');
  });

  it('defaults to id when language_pref is omitted', () => {
    const { language_pref: _drop, ...without } = VALID_BASE;
    void _drop;
    const result = profileSchema.parse(without);
    expect(result.language_pref).toBe('id');
  });

  it('rejects an unsupported language', () => {
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, language_pref: 'fr' }),
    ).toThrow();
  });
});

describe('profileSchema — strict mode', () => {
  it('rejects unknown keys', () => {
    expect(() =>
      profileSchema.parse({ ...VALID_BASE, role: 'Super_Admin' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadProfile
// ---------------------------------------------------------------------------

describe('loadProfile', () => {
  it('returns null when the applicants row does not exist', async () => {
    queryMock.mockResolvedValueOnce([]);
    const result = await loadProfile(42);
    expect(result).toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SELECT[\s\S]+FROM applicants WHERE user_id = \?/i);
    expect(params).toEqual([42]);
  });

  it('hydrates a typed ProfileRecord from the row', async () => {
    const row = {
      user_id: 42,
      full_name: 'Sari Pelita',
      date_of_birth: new Date('1995-04-12T00:00:00.000Z'),
      gender: 'female',
      phone: '+6281234567890',
      address: 'Jl. Mawar 12',
      city: 'Bandung',
      province: 'Jawa Barat',
      country: 'Indonesia',
      summary: 'Frontend engineer',
      language_pref: 'id',
    } as unknown as RowDataPacket;
    queryMock.mockResolvedValueOnce([row]);

    const result = await loadProfile(42);
    expect(result).toEqual({
      user_id: 42,
      full_name: 'Sari Pelita',
      date_of_birth: '1995-04-12',
      gender: 'female',
      phone: '+6281234567890',
      address: 'Jl. Mawar 12',
      city: 'Bandung',
      province: 'Jawa Barat',
      country: 'Indonesia',
      summary: 'Frontend engineer',
      language_pref: 'id',
    });
  });

  it('passes through a date that is already a YYYY-MM-DD string', async () => {
    const row = {
      user_id: 7,
      full_name: 'Bagus',
      date_of_birth: '2000-06-15',
      gender: null,
      phone: null,
      address: null,
      city: null,
      province: null,
      country: null,
      summary: null,
      language_pref: 'en',
    } as unknown as RowDataPacket;
    queryMock.mockResolvedValueOnce([row]);

    const result = await loadProfile(7);
    expect(result?.date_of_birth).toBe('2000-06-15');
    expect(result?.gender).toBeNull();
    expect(result?.phone).toBeNull();
    expect(result?.language_pref).toBe('en');
  });

  it('returns null date_of_birth when the column is null', async () => {
    const row = {
      user_id: 8,
      full_name: 'Anon',
      date_of_birth: null,
      gender: null,
      phone: null,
      address: null,
      city: null,
      province: null,
      country: null,
      summary: null,
      language_pref: 'id',
    } as unknown as RowDataPacket;
    queryMock.mockResolvedValueOnce([row]);

    const result = await loadProfile(8);
    expect(result?.date_of_birth).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateProfile
// ---------------------------------------------------------------------------

describe('updateProfile', () => {
  it('runs the UPDATE with parameters in the documented order and returns affected count', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(1));

    const dob = yearsAgoIsoYmd(25);
    const input = {
      full_name: 'Sari Pelita',
      date_of_birth: dob,
      gender: 'female',
      phone: '+6281234567890',
      address: 'Jl. Mawar 12',
      city: 'Bandung',
      province: 'Jawa Barat',
      country: 'Indonesia',
      summary: 'Frontend engineer with 4 years of experience.',
      language_pref: 'id',
    };

    const result = await updateProfile(42, input);
    expect(result.affected).toBe(1);
    expect(result.profile.full_name).toBe('Sari Pelita');
    expect(result.profile.phone).toBe('+6281234567890');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE applicants SET/i);
    expect(sql).toMatch(/WHERE user_id = \?$/);
    expect(params).toEqual([
      'Sari Pelita',
      dob,
      'female',
      '+6281234567890',
      'Jl. Mawar 12',
      'Bandung',
      'Jawa Barat',
      'Indonesia',
      'Frontend engineer with 4 years of experience.',
      'id',
      42,
    ]);
  });

  it('writes SQL NULL for empty optional fields', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(1));

    const input = {
      full_name: 'Bagus',
      date_of_birth: '',
      gender: '',
      phone: '',
      address: '',
      city: '',
      province: '',
      country: '',
      summary: '',
      language_pref: 'en',
    };

    await updateProfile(99, input);
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([
      'Bagus',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'en',
      99,
    ]);
  });

  it('returns affected=0 when the WHERE matches no row', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(0));
    const result = await updateProfile(1, {
      full_name: 'Anon',
      language_pref: 'id',
    });
    expect(result.affected).toBe(0);
  });

  it('throws ZodError without issuing a query when input is invalid', async () => {
    await expect(
      updateProfile(1, { full_name: '', language_pref: 'id' }),
    ).rejects.toThrow(ZodError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('throws ZodError on under-18 date_of_birth', async () => {
    const dob = yearsAgoIsoYmd(10);
    await expect(
      updateProfile(1, {
        full_name: 'Bagus',
        date_of_birth: dob,
        language_pref: 'id',
      }),
    ).rejects.toThrow(/at least 18 years old/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('canonicalises phone (adds + prefix) before persisting', async () => {
    queryMock.mockResolvedValueOnce(makeHeader(1));
    await updateProfile(42, {
      full_name: 'Sari',
      phone: '6281234567890',
      language_pref: 'id',
    });
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    // params index 3 is `phone` per the UPDATE column order.
    expect(params[3]).toBe('+6281234567890');
  });
});

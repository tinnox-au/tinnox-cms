import { describe, expect, it } from 'vitest';
import { errorField } from './error-field.ts';

describe('errorField', () => {
  it("reads a field of an error, such as pg's code and constraint", () => {
    const error = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'tag_org_scope_name_key',
    });
    expect(errorField(error, 'code')).toBe('23505');
    expect(errorField(error, 'constraint')).toBe('tag_org_scope_name_key');
  });

  it('returns the value whatever its type; the caller checks it', () => {
    expect(errorField({ code: 535 }, 'code')).toBe(535);
    expect(errorField({ code: null }, 'code')).toBeNull();
  });

  it('reads inherited fields and getters, as a property access does', () => {
    class DriverError extends Error {
      get code(): string {
        return 'ECONNRESET';
      }
    }
    expect(errorField(new DriverError(), 'code')).toBe('ECONNRESET');
    expect(errorField(Object.create({ code: 'EPIPE' }), 'code')).toBe('EPIPE');
  });

  it('reads a field of a thrown function, as `(error as { code?: unknown })?.code` did', () => {
    expect(
      errorField(
        Object.assign(() => undefined, { code: 'E1' }),
        'code',
      ),
    ).toBe('E1');
  });

  it.each([null, undefined, 'a string', 42, true, Symbol('s'), 10n])(
    'returns undefined for %s, which has no fields to read',
    (value) => {
      expect(errorField(value, 'code')).toBeUndefined();
    },
  );

  it('returns undefined when the object has no such field', () => {
    expect(errorField(new Error('x'), 'code')).toBeUndefined();
    expect(errorField({}, 'constraint')).toBeUndefined();
  });
});

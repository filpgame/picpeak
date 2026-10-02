const { decodeJsonColumn } = require('../../src/utils/jsonColumn');

describe('decodeJsonColumn', () => {
  describe('SQLite shape (JSON text)', () => {
    it('parses an object', () => {
      expect(decodeJsonColumn('{"ip":"1.2.3.4","n":2}')).toEqual({ ip: '1.2.3.4', n: 2 });
    });

    it('parses a string scalar', () => {
      expect(decodeJsonColumn('"simple"')).toBe('simple');
    });

    it('parses numbers and booleans', () => {
      expect(decodeJsonColumn('5000')).toBe(5000);
      expect(decodeJsonColumn('true')).toBe(true);
    });
  });

  describe('PostgreSQL shape (decoded by node-pg)', () => {
    it('returns objects and arrays untouched', () => {
      const obj = { ip: '1.2.3.4' };
      const arr = ['a', 'b'];
      expect(decodeJsonColumn(obj)).toBe(obj);
      expect(decodeJsonColumn(arr)).toBe(arr);
    });

    it('keeps an already-decoded string scalar', () => {
      expect(decodeJsonColumn('simple')).toBe('simple');
    });

    it('returns numbers and booleans untouched', () => {
      expect(decodeJsonColumn(5000)).toBe(5000);
      expect(decodeJsonColumn(false)).toBe(false);
    });
  });

  it('returns the fallback for null and undefined', () => {
    expect(decodeJsonColumn(null)).toBeNull();
    expect(decodeJsonColumn(undefined, {})).toEqual({});
  });
});

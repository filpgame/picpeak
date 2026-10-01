const knexFactory = require('knex');
const { formatBoolean, isPostgreSQL, addDays, formatDateForDB, insertAndGetId, whereTimestamp } = require('../utils/dbCompat');

describe('Database Compatibility', () => {
  // Save original env
  const originalEnv = process.env.DATABASE_CLIENT;
  
  afterEach(() => {
    // Restore original env after each test
    if (originalEnv) {
      process.env.DATABASE_CLIENT = originalEnv;
    } else {
      delete process.env.DATABASE_CLIENT;
    }
  });

  describe('formatBoolean', () => {
    test('should format boolean values correctly', () => {
      // Mock for SQLite
      process.env.DATABASE_CLIENT = 'sqlite3';
      expect(formatBoolean(true)).toBe(1);
      expect(formatBoolean(false)).toBe(0);
      
      // Mock for PostgreSQL
      process.env.DATABASE_CLIENT = 'pg';
      expect(formatBoolean(true)).toBe(true);
      expect(formatBoolean(false)).toBe(false);
      
      // Default (no env var) should be SQLite
      delete process.env.DATABASE_CLIENT;
      expect(formatBoolean(true)).toBe(1);
      expect(formatBoolean(false)).toBe(0);
    });
  });

  describe('isPostgreSQL', () => {
    test('should detect PostgreSQL correctly', () => {
      process.env.DATABASE_CLIENT = 'pg';
      expect(isPostgreSQL()).toBe(true);
      
      process.env.DATABASE_CLIENT = 'sqlite3';
      expect(isPostgreSQL()).toBe(false);
      
      delete process.env.DATABASE_CLIENT;
      expect(isPostgreSQL()).toBe(false); // Default to SQLite
    });
  });

  describe('formatDateForDB', () => {
    test('should format dates as ISO strings', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      expect(formatDateForDB(date)).toBe('2024-01-15T10:30:00.000Z');
    });
  });

  describe('addDays', () => {
    test('should add days correctly', () => {
      const date = new Date('2024-01-15');
      const result = addDays(date, 30);
      expect(result.toISOString().split('T')[0]).toBe('2024-02-14');
      
      const negativeResult = addDays(date, -7);
      expect(negativeResult.toISOString().split('T')[0]).toBe('2024-01-08');
    });
  });

  describe('insertAndGetId', () => {
    test('should handle PostgreSQL result format', async () => {
      const mockQuery = {
        returning: jest.fn().mockResolvedValue([{ id: 123 }])
      };
      const result = await insertAndGetId(mockQuery);
      expect(result).toBe(123);
    });

    test('should handle SQLite result format', async () => {
      const mockQuery = {
        returning: jest.fn().mockResolvedValue([456])
      };
      const result = await insertAndGetId(mockQuery);
      expect(result).toBe(456);
    });
  });

  describe('whereTimestamp', () => {
    // 2026-10-01T12:00:00.000Z
    const now = new Date(Date.UTC(2026, 9, 1, 12, 0, 0));

    test('on PostgreSQL, emits a plain comparison with the Date bound unchanged', async () => {
      process.env.DATABASE_CLIENT = 'pg';
      const pg = knexFactory({ client: 'pg' });

      const { sql, bindings } = pg('events').modify(whereTimestamp, 'expires_at', '<=', now).toSQL();

      expect(sql).toBe('select * from "events" where "expires_at" <= ?');
      expect(bindings).toEqual([now]);
      await pg.destroy();
    });

    describe('on SQLite', () => {
      let sqlite;

      // Each format a datetime column holds on SQLite, as written by the app:
      // TEXT 'YYYY-MM-DD' / ISO 8601 (with or without an offset), or INTEGER
      // epoch milliseconds where a JS Date object was written directly.
      const ROWS = [
        { label: 'date-only-yesterday', expires_at: '2026-09-30' },
        { label: 'date-only-today', expires_at: '2026-10-01' }, // midnight UTC
        { label: 'date-only-tomorrow', expires_at: '2026-10-02' },
        { label: 'iso-1ms-before', expires_at: '2026-10-01T11:59:59.999Z' },
        { label: 'iso-equal', expires_at: '2026-10-01T12:00:00.000Z' },
        { label: 'iso-1ms-after', expires_at: '2026-10-01T12:00:00.001Z' },
        { label: 'iso-offset-1h-after', expires_at: '2026-10-01T10:00:00-03:00' }, // 13:00Z
        { label: 'epoch-ms-1h-before', expires_at: 1790852400000 }, // 11:00Z
        { label: 'epoch-ms-equal', expires_at: 1790856000000 }, // 12:00Z
        { label: 'epoch-ms-1h-after', expires_at: 1790859600000 }, // 13:00Z
        { label: 'never', expires_at: null },
      ];

      beforeEach(async () => {
        process.env.DATABASE_CLIENT = 'sqlite3';
        sqlite = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
        await sqlite.schema.createTable('events', (table) => {
          table.increments('id');
          table.string('label');
          table.datetime('expires_at');
        });
        await sqlite('events').insert(ROWS);
      });

      afterEach(async () => {
        await sqlite.destroy();
      });

      test.each([
        ['<', ['date-only-today', 'date-only-yesterday', 'epoch-ms-1h-before', 'iso-1ms-before']],
        ['<=', ['date-only-today', 'date-only-yesterday', 'epoch-ms-1h-before', 'epoch-ms-equal', 'iso-1ms-before', 'iso-equal']],
        ['>', ['date-only-tomorrow', 'epoch-ms-1h-after', 'iso-1ms-after', 'iso-offset-1h-after']],
        ['>=', ['date-only-tomorrow', 'epoch-ms-1h-after', 'epoch-ms-equal', 'iso-1ms-after', 'iso-equal', 'iso-offset-1h-after']],
      ])('expires_at %s now matches by instant across TEXT and INTEGER storage', async (operator, expected) => {
        const labels = await sqlite('events')
          .modify(whereTimestamp, 'expires_at', operator, now)
          .pluck('label');

        expect(labels.sort()).toEqual(expected);
      });

      // The operator is spliced into raw SQL on SQLite, so only the range
      // comparisons are accepted.
      test.each(['=', '<>', 'like', '<= 0 OR 1 = 1 --'])('rejects the %s operator', (operator) => {
        expect(() => sqlite('events').modify(whereTimestamp, 'expires_at', operator, now)).toThrow(/operator/);
      });
    });
  });
});
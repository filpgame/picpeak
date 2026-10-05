const DATE_OID = 1082;

describe('db.js PostgreSQL date parsing', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('returns date columns as YYYY-MM-DD text on PostgreSQL', () => {
    jest.isolateModules(() => {
      jest.doMock('../../knexfile', () => ({ client: 'pg', connection: {} }));
      require('../../src/database/db');
      const pgTypes = require('pg').types;
      expect(pgTypes.getTypeParser(DATE_OID)('2026-10-01')).toBe('2026-10-01');
    });
  });
});

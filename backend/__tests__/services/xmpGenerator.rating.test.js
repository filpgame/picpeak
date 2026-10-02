const { XmpGenerator } = require('../../src/services/xmpGenerator');

describe('XmpGenerator rating mapping', () => {
  const xmp = new XmpGenerator();

  it('treats an unrated photo as unrated in both driver shapes', () => {
    // SQLite returns AVG() as a number, PostgreSQL as a numeric string.
    for (const unrated of [0, '0.00', null, undefined]) {
      expect(xmp.mapRating(unrated)).toBe(0);
      expect(xmp.mapLabel(unrated)).toBeNull();
    }
  });

  it('maps numeric strings like numbers', () => {
    expect(xmp.mapRating('4.50')).toBe(xmp.mapRating(4.5));
    expect(xmp.mapRating('4.50')).toBe(5);
    expect(xmp.mapLabel('3.75')).toBe('Yellow');
    expect(xmp.mapRating('1.00')).toBe(1);
  });
});

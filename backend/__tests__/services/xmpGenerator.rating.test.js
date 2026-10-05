const { XmpGenerator } = require('../../src/services/xmpGenerator');

describe('XmpGenerator rating and label in both driver shapes', () => {
  const xmp = new XmpGenerator();

  it('treats an unrated photo as unrated whether AVG() is a number or a numeric string', () => {
    // SQLite returns AVG() as a number, PostgreSQL as a numeric string.
    for (const unrated of [0, '0.00', null, undefined]) {
      expect(xmp.mapRating(unrated)).toBe(0);
      expect(xmp.mapRatingToLabel(unrated)).toBeNull();
      expect(xmp.mapLabel({ average_rating: unrated })).toBeNull();
    }
  });

  it('maps numeric strings like numbers', () => {
    expect(xmp.mapRatingToLabel('4.50')).toBe(xmp.mapRatingToLabel(4.5));
    expect(xmp.mapRatingToLabel('3.75')).toBe('Yellow');
    expect(xmp.mapLabel({ average_rating: '1.00' })).toBe('Purple');
    expect(xmp.mapRating('4.50')).toBe(xmp.mapRating(4.5));
  });

  it('omits the label from the sidecar of an unrated PostgreSQL row', () => {
    const sidecar = xmp.generateXmp({ average_rating: '0.00', filename: 'a.jpg' });
    expect(sidecar).toContain('xmp:Rating="0"');
    expect(sidecar).not.toContain('xmp:Label=');
  });
});

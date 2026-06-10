/**
 * Unit tests for the expense money/markup logic — the silently-regressable
 * bits of the re-bill flow. Pure functions only (no DB), via _internal.
 */
const expenseService = require('../../src/services/expenseService');

const { computeMarkupMinor, resolveMarkup, buildExpenseInsert } = expenseService._internal;

describe('computeMarkupMinor', () => {
  it('percent of base, rounded to integer minor units', () => {
    expect(computeMarkupMinor(10000, { type: 'percent', percent: 10 })).toBe(1000);
    expect(computeMarkupMinor(333, { type: 'percent', percent: 10 })).toBe(33); // 33.3 -> 33
    expect(computeMarkupMinor(335, { type: 'percent', percent: 10 })).toBe(34); // 33.5 -> 34
  });

  it('flat adds the flat minor amount', () => {
    expect(computeMarkupMinor(10000, { type: 'flat', flatMinor: 500 })).toBe(500);
  });

  it('none / missing values add nothing', () => {
    expect(computeMarkupMinor(10000, { type: 'none' })).toBe(0);
    expect(computeMarkupMinor(10000, { type: 'percent', percent: null })).toBe(0);
    expect(computeMarkupMinor(10000, { type: 'flat', flatMinor: null })).toBe(0);
  });
});

describe('resolveMarkup precedence (no contract / no DB)', () => {
  it('explicit override wins over the expense clause', async () => {
    const expense = { markupType: 'flat', markupFlatMinor: 999 };
    const override = { markupType: 'percent', markupPercent: 5 };
    await expect(resolveMarkup(expense, override, null, null))
      .resolves.toEqual({ type: 'percent', percent: 5, flatMinor: null });
  });

  it("falls back to the expense's own clause when no override", async () => {
    const expense = { markupType: 'flat', markupFlatMinor: 200 };
    await expect(resolveMarkup(expense, {}, null, null))
      .resolves.toEqual({ type: 'flat', percent: null, flatMinor: 200 });
  });

  it('defaults to none when nothing is set', async () => {
    await expect(resolveMarkup({ markupType: 'none' }, {}, null, null))
      .resolves.toEqual({ type: 'none', percent: null, flatMinor: null });
  });
});

describe('buildExpenseInsert', () => {
  it('rejects an unknown disposition', () => {
    expect(() => buildExpenseInsert({ disposition: 'bogus' }, 1)).toThrow(/disposition/);
  });

  it('defaults tax_treatment to domestic and status to open', () => {
    const row = buildExpenseInsert({ disposition: 'eigener_aufwand' }, 7);
    expect(row.tax_treatment).toBe('domestic');
    expect(row.status).toBe('open');
    expect(row.created_by_admin_id).toBe(7);
  });

  it('declined disposition sets status=declined + keeps the reason', () => {
    const row = buildExpenseInsert({ disposition: 'abgelehnt', declineReason: 'not ours' }, 1);
    expect(row.status).toBe('declined');
    expect(row.decline_reason).toBe('not ours');
  });

  it('only persists the markup field that matches the markup type', () => {
    const pct = buildExpenseInsert({ disposition: 'rebill', markupType: 'percent', markupPercent: 12, markupFlatMinor: 500 }, 1);
    expect(pct.markup_percent).toBe(12);
    expect(pct.markup_flat_minor).toBeNull();

    const flat = buildExpenseInsert({ disposition: 'rebill', markupType: 'flat', markupPercent: 12, markupFlatMinor: 500 }, 1);
    expect(flat.markup_flat_minor).toBe(500);
    expect(flat.markup_percent).toBeNull();
  });

  it('parked flag maps to status=parked', () => {
    const row = buildExpenseInsert({ disposition: 'rebill', unbilledParked: true }, 1);
    expect(row.status).toBe('parked');
    expect(row.unbilled_parked).toBe(true);
  });
});

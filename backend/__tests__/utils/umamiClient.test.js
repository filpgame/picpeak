/**
 * Unit tests for the Umami v2 metrics-API client (#661 Bug C).
 *
 * The client is only consumed by `/admin/dashboard/analytics` today to fetch
 * the device-breakdown chart, so these tests pin:
 *  - The exact URL shape sent to Umami (`/api/websites/<id>/metrics?type=device&startAt=…&endAt=…`)
 *  - The `x-umami-api-key` auth header
 *  - The `{ x, y }` → `{ desktop, mobile, tablet }` percentage normalisation
 *  - `laptop` mapping into `desktop` for our 3-bucket UI
 *  - Defensive returns: missing config / non-2xx / non-JSON / empty array
 *    all return `null` so the route layer can fall back to access_logs.
 */

const { fetchUmamiDeviceBreakdown } = require('../../src/services/umamiClient');

const ORIGINAL_FETCH = global.fetch;

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function mockJson(body, { status = 200 } = {}) {
  global.fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe('fetchUmamiDeviceBreakdown', () => {
  test('returns null when config is incomplete (back-compat for installs without API key)', async () => {
    expect(await fetchUmamiDeviceBreakdown({})).toBeNull();
    expect(await fetchUmamiDeviceBreakdown({ baseUrl: 'https://u.example' })).toBeNull();
    expect(await fetchUmamiDeviceBreakdown({ baseUrl: 'https://u.example', websiteId: 'w' })).toBeNull();
    // No fetch should be issued in any of those cases.
    expect(global.fetch).toBe(ORIGINAL_FETCH);
  });

  test('builds the expected URL + sends the x-umami-api-key header', async () => {
    mockJson([{ x: 'desktop', y: 10 }]);
    await fetchUmamiDeviceBreakdown({
      baseUrl: 'https://u.example.com/',
      websiteId: 'site-123',
      apiKey: 'secret',
      startMs: 1700000000000,
      endMs: 1700003600000,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe(
      'https://u.example.com/api/websites/site-123/metrics?type=device&startAt=1700000000000&endAt=1700003600000',
    );
    expect(init.headers['x-umami-api-key']).toBe('secret');
    expect(init.method).toBe('GET');
  });

  test('encodes the websiteId so a path segment with reserved chars is safe', async () => {
    mockJson([{ x: 'desktop', y: 1 }]);
    await fetchUmamiDeviceBreakdown({
      baseUrl: 'https://u.example.com',
      websiteId: 'a/b?c',
      apiKey: 'k',
      startMs: 0, endMs: 0,
    });
    const [calledUrl] = global.fetch.mock.calls[0];
    expect(calledUrl).toContain('/api/websites/a%2Fb%3Fc/metrics');
  });

  test('normalises a typical { x, y } payload into integer percentages', async () => {
    mockJson([
      { x: 'desktop', y: 60 },
      { x: 'mobile', y: 30 },
      { x: 'tablet', y: 10 },
    ]);
    const out = await fetchUmamiDeviceBreakdown({
      baseUrl: 'https://u', websiteId: 'w', apiKey: 'k', startMs: 0, endMs: 0,
    });
    expect(out).toEqual({ desktop: 60, mobile: 30, tablet: 10 });
  });

  test('maps `laptop` into `desktop` for the 3-bucket UI', async () => {
    mockJson([
      { x: 'desktop', y: 50 },
      { x: 'laptop', y: 20 },
      { x: 'mobile', y: 30 },
    ]);
    const out = await fetchUmamiDeviceBreakdown({
      baseUrl: 'https://u', websiteId: 'w', apiKey: 'k', startMs: 0, endMs: 0,
    });
    // desktop = (50 + 20) / 100 = 70%
    expect(out).toEqual({ desktop: 70, mobile: 30, tablet: 0 });
  });

  test('drops unknown buckets entirely (avoids silent miscategorisation)', async () => {
    mockJson([
      { x: 'desktop', y: 80 },
      { x: 'mobile', y: 20 },
      { x: 'unknown-future-bucket', y: 100 },
    ]);
    const out = await fetchUmamiDeviceBreakdown({
      baseUrl: 'https://u', websiteId: 'w', apiKey: 'k', startMs: 0, endMs: 0,
    });
    // 100 isn't counted into total, so 80/(80+20) = 80%, 20/(80+20) = 20%.
    expect(out).toEqual({ desktop: 80, mobile: 20, tablet: 0 });
  });

  test('returns null on empty payload (caller falls back to access_logs)', async () => {
    mockJson([]);
    const out = await fetchUmamiDeviceBreakdown({
      baseUrl: 'https://u', websiteId: 'w', apiKey: 'k', startMs: 0, endMs: 0,
    });
    expect(out).toBeNull();
  });

  test('returns null on non-2xx upstream response', async () => {
    mockJson({ error: 'unauthorized' }, { status: 401 });
    const out = await fetchUmamiDeviceBreakdown({
      baseUrl: 'https://u', websiteId: 'w', apiKey: 'k', startMs: 0, endMs: 0,
    });
    expect(out).toBeNull();
  });

  test('returns null on invalid JSON body', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('not json'); },
    }));
    const out = await fetchUmamiDeviceBreakdown({
      baseUrl: 'https://u', websiteId: 'w', apiKey: 'k', startMs: 0, endMs: 0,
    });
    expect(out).toBeNull();
  });

  test('returns null on network error (fetch throws)', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    const out = await fetchUmamiDeviceBreakdown({
      baseUrl: 'https://u', websiteId: 'w', apiKey: 'k', startMs: 0, endMs: 0,
    });
    expect(out).toBeNull();
  });
});

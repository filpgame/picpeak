/**
 * Thin Umami v2 API client (#661 Bug C).
 *
 * We use this in exactly one place today — `GET /admin/dashboard/analytics`
 * pulls device-breakdown stats from Umami when an admin has provided an
 * API key, because our own user-agent heuristic on `access_logs` returns
 * 0/0/0 on installs where guest UAs don't reliably contain "Mobile" /
 * "Tablet" tokens. Umami tracks devices natively.
 *
 * Auth: Umami v2 supports per-account API keys generated in the Umami UI
 * (Settings → Profile → API Keys). We send them via the `x-umami-api-key`
 * header. Older session-cookie-based auth is intentionally NOT supported
 * here — operators should generate an API key rather than embedding their
 * Umami account password in PicPeak.
 */

const logger = require('../utils/logger');

const REQUEST_TIMEOUT_MS = 5000;

/**
 * Fetch the device breakdown for a Umami website in [startMs, endMs]. Returns
 * `{ desktop, mobile, tablet }` as integer percentages summing to ~100, or
 * `null` when the upstream call fails / returns no data — callers should
 * treat null as "fall back to the local heuristic".
 *
 * @param {object} opts
 * @param {string} opts.baseUrl    — Umami instance root, e.g. https://analytics.example.com
 * @param {string} opts.websiteId  — UUID from the Umami website settings
 * @param {string} opts.apiKey     — Umami API key (x-umami-api-key)
 * @param {number} opts.startMs    — epoch ms, start of window
 * @param {number} opts.endMs      — epoch ms, end of window
 */
async function fetchUmamiDeviceBreakdown({ baseUrl, websiteId, apiKey, startMs, endMs }) {
  if (!baseUrl || !websiteId || !apiKey) return null;

  const trimmedBase = String(baseUrl).replace(/\/+$/, '');
  const url = `${trimmedBase}/api/websites/${encodeURIComponent(websiteId)}/metrics`
    + `?type=device&startAt=${encodeURIComponent(startMs)}&endAt=${encodeURIComponent(endMs)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-umami-api-key': apiKey,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      logger.warn('Umami device fetch: timeout', { url });
      return null;
    }
    logger.warn('Umami device fetch: network error', { error: err.message });
    return null;
  }
  clearTimeout(timer);

  if (!response.ok) {
    logger.warn('Umami device fetch: non-2xx', { status: response.status });
    return null;
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    logger.warn('Umami device fetch: invalid JSON', { error: err.message });
    return null;
  }

  if (!Array.isArray(data)) return null;

  // Umami buckets device types into these strings: `desktop`, `mobile`,
  // `tablet`, `laptop`. Map `laptop` → `desktop` for our 3-bucket UI; drop
  // anything we don't recognise (vs. silently miscategorising).
  const counts = { desktop: 0, mobile: 0, tablet: 0 };
  let total = 0;
  for (const entry of data) {
    if (!entry || typeof entry.x !== 'string') continue;
    const n = Number(entry.y);
    if (!Number.isFinite(n) || n <= 0) continue;
    const key = entry.x === 'laptop' ? 'desktop' : entry.x;
    if (key in counts) {
      counts[key] += n;
      total += n;
    }
  }

  if (total === 0) return null;

  return {
    desktop: Math.round((counts.desktop / total) * 100),
    mobile: Math.round((counts.mobile / total) * 100),
    tablet: Math.round((counts.tablet / total) * 100),
  };
}

module.exports = { fetchUmamiDeviceBreakdown };

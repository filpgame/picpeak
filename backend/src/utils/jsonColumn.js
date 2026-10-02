/**
 * Decode a value read from a json/jsonb column on either database driver.
 *
 * SQLite stores JSON as TEXT, so rows carry the JSON string ('{"a":1}',
 * '"simple"'). On PostgreSQL the same columns are json/jsonb and node-pg
 * parses them on read, so rows carry the decoded value ({ a: 1 }, 'simple').
 * A bare JSON.parse breaks on PG: objects stringify to "[object Object]" and
 * already-decoded strings are not valid JSON.
 *
 * Strings are parsed when they hold JSON; a string that is not valid JSON is
 * an already-decoded string scalar and is returned as-is. Anything else
 * (object, array, number, boolean) is already decoded. null/undefined yield
 * `fallback`.
 */
function decodeJsonColumn(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return value;
  }
}

module.exports = { decodeJsonColumn };

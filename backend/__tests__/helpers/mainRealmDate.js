/**
 * Make JS Dates bind in SQLite queries exactly as they do in production.
 *
 * Jest runs each test file in its own V8 realm, and node-sqlite3 only
 * recognises Dates from the main realm (an `instanceof` check against its own
 * global Date): a sandbox Date is bound as the string '[object Object]'
 * instead of a REAL holding epoch milliseconds. That hides every bug where a
 * Date is compared against a TEXT date column. Swapping in the main realm's
 * Date makes every `new Date()` — in the test and in the code under test —
 * bind as in production.
 *
 * Call at the top of a test file; returns a function that restores the
 * sandbox Date (call it in afterAll).
 */
function useMainRealmDate() {
  const sandboxDate = global.Date;
  global.Date = require('vm').runInThisContext('Date');
  return () => {
    global.Date = sandboxDate;
  };
}

module.exports = { useMainRealmDate };

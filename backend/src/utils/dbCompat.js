/**
 * Database Compatibility Utilities
 * Handles differences between PostgreSQL and SQLite
 */

// Note: Requiring db here creates circular dependency
// db should be passed as parameter or required where needed
const logger = require('./logger');

/**
 * Get database client type
 * @returns {string} 'pg' or 'sqlite3'
 */
function getDbClient() {
  return process.env.DATABASE_CLIENT || 'sqlite3';
}

/**
 * Check if using PostgreSQL
 * @returns {boolean}
 */
function isPostgreSQL() {
  return getDbClient() === 'pg';
}

/**
 * Handle insert operations that return IDs
 * Works with both PostgreSQL and SQLite
 * @param {object} query - Knex query builder
 * @returns {Promise<number>} The inserted ID
 */
async function insertAndGetId(query) {
  const result = await query.returning('id');
  
  // PostgreSQL returns array of objects [{id: 1}]
  // SQLite returns array of IDs [1]
  return result[0]?.id || result[0];
}

/**
 * Format date for database compatibility
 * @param {Date} date - JavaScript Date object
 * @returns {string} ISO string format that works on both databases
 */
function formatDateForDB(date) {
  return date.toISOString();
}

const TIMESTAMP_OPERATORS = new Set(['<', '<=', '>', '>=']);

/**
 * Compare a date/time column against a JS Date the same way on both databases.
 * Use with Knex `.modify()`:
 *   db('events').modify(whereTimestamp, 'expires_at', '<=', new Date())
 *
 * PostgreSQL compares its native timestamps against the bound Date. SQLite has
 * no date type: the column holds TEXT ('YYYY-MM-DD' or ISO 8601) or, where a
 * JS Date was written directly, INTEGER epoch milliseconds — while a bound Date
 * is a REAL, and SQLite sorts every number before every TEXT value, so a plain
 * `column <= date` never matches a TEXT row. Compare both sides as epoch
 * milliseconds instead (julianday() also honours a TEXT value's UTC offset).
 *
 * @param {object} query - Knex query builder
 * @param {string} column - Date/time column name
 * @param {string} operator - One of '<', '<=', '>', '>='
 * @param {Date} date - Value to compare against
 * @returns {object} The query builder
 */
function whereTimestamp(query, column, operator, date) {
  if (!TIMESTAMP_OPERATORS.has(operator)) {
    throw new Error(`Unsupported timestamp comparison operator: ${operator}`);
  }
  if (isPostgreSQL()) {
    return query.where(column, operator, date);
  }
  return query.whereRaw(
    `(CASE WHEN typeof(??) IN ('integer', 'real') THEN ?? ELSE (julianday(??) - 2440587.5) * 86400000 END) ${operator} ?`,
    [column, column, column, date.getTime()]
  );
}

/**
 * Add days to a date (database agnostic)
 * @param {Date} date - Starting date
 * @param {number} days - Number of days to add
 * @returns {Date} New date
 */
function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Get date extraction SQL that works on both databases
 * @param {object} db - Knex database instance
 * @param {string} column - Column name
 * @returns {object} Knex raw query
 */
function dateExtractSQL(db, column) {
  if (isPostgreSQL()) {
    return db.raw(`DATE(${column})`);
  } else {
    // SQLite uses date() function
    return db.raw(`date(${column})`);
  }
}

/**
 * Get database size query
 * @param {object} db - Knex database instance
 * @param {string} dbName - Database name
 * @returns {Promise<number>} Size in bytes
 */
async function getDatabaseSize(db, dbName) {
  if (isPostgreSQL()) {
    const result = await db.raw('SELECT pg_database_size(?) as size', [dbName]);
    return result.rows[0]?.size || 0;
  } else {
    // For SQLite, check file size
    const fs = require('fs').promises;
    const path = require('path');
    const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../data/photo_sharing.db');
    try {
      const stats = await fs.stat(dbPath);
      return stats.size;
    } catch (error) {
      logger.error('Error getting SQLite database size:', error);
      return 0;
    }
  }
}

/**
 * Handle boolean values for database compatibility
 * @param {boolean} value - Boolean value
 * @returns {any} Database-appropriate boolean representation
 */
function formatBoolean(value) {
  if (isPostgreSQL()) {
    return value;
  } else {
    // SQLite stores booleans as 0/1
    return value ? 1 : 0;
  }
}

/**
 * Parse boolean from database
 * @param {any} value - Database boolean value
 * @returns {boolean} JavaScript boolean
 */
function parseBoolean(value) {
  return Boolean(value);
}

module.exports = {
  getDbClient,
  isPostgreSQL,
  insertAndGetId,
  formatDateForDB,
  whereTimestamp,
  addDays,
  dateExtractSQL,
  getDatabaseSize,
  formatBoolean,
  parseBoolean
};
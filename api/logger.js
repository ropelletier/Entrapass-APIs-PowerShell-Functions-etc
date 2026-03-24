/**
 * logger.js — API audit logger
 *
 * Writes one JSON line per event to api-audit.log in LOG_DIR (or ../logs).
 * Uses AsyncLocalStorage so every db_write entry carries the reqId of the
 * HTTP request that caused it — no manual threading required.
 *
 * Event types:
 *   request   — incoming HTTP call (method, path, query/body, key name)
 *   db_write  — every INSERT / UPDATE / DELETE sent to ADS (sql + description)
 *   response  — HTTP response sent (status, duration)
 *
 * Usage:
 *   const { requestLogger } = require('./logger');
 *   app.use(requestLogger);           // in server.js, before routes
 *
 *   const { logDbWrite } = require('./logger');
 *   logDbWrite(sql);                  // in db.js execute()
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const LOG_DIR  = process.env.LOG_DIR
  ? process.env.LOG_DIR
  : path.resolve(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'api-audit.log');

const als = new AsyncLocalStorage();
let _reqCounter = 0;

// ---------------------------------------------------------------------------
// Internal write
// ---------------------------------------------------------------------------
function write(entry) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const store = als.getStore();
    const line  = JSON.stringify({
      ts:    new Date().toISOString(),
      reqId: store ? store.reqId : null,
      ...entry,
    }) + '\n';
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) { /* never crash the API over a log failure */ }
}

// ---------------------------------------------------------------------------
// SQL → human-readable description
// ---------------------------------------------------------------------------
function describeSql(sql) {
  const s = sql.replace(/\s+/g, ' ').trim();

  // INSERT INTO Table (col1, col2, ...) VALUES (...)
  const ins = s.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/i);
  if (ins) {
    const cols = ins[2].replace(/\s+/g, ' ').split(',').map(c => c.trim());
    return `INSERT into ${ins[1]} — columns: ${cols.join(', ')}`;
  }

  // UPDATE Table SET col=val, ... WHERE condition
  const upd = s.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i);
  if (upd) {
    const table  = upd[1];
    const sets   = upd[2].trim();
    const where  = upd[3].trim();
    // Parse individual SET assignments for clarity
    const pairs  = sets.split(/,\s*(?=\w+\s*=)/).map(p => p.trim());
    return `UPDATE ${table} — set: ${pairs.join(' | ')} — where: ${where}`;
  }

  // DELETE FROM Table WHERE condition
  const del = s.match(/^DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/i);
  if (del) {
    return `DELETE from ${del[1]}${del[2] ? ' — where: ' + del[2].trim() : ' (no WHERE — full table!)'}`;
  }

  return s.substring(0, 300);
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

/**
 * Mount this before all routes in server.js:
 *   app.use(requestLogger);
 */
function requestLogger(req, res, next) {
  const reqId   = ++_reqCounter;
  const startMs = Date.now();

  als.run({ reqId }, () => {
    // Sanitise body — omit completely when empty, mask any raw key fields
    let body;
    if (req.body && Object.keys(req.body).length) {
      body = { ...req.body };
      // Never log a raw API key value that might appear in a create-key request
      if (body.key) body.key = '[redacted]';
    }

    write({
      type:    'request',
      method:  req.method,
      path:    req.originalUrl,
      body:    body || undefined,
      keyName: req.apiKey ? req.apiKey.name : undefined,  // set by auth after this fires
    });

    // Log the response after it is flushed
    res.on('finish', () => {
      write({
        type:       'response',
        method:     req.method,
        path:       req.originalUrl,
        status:     res.statusCode,
        durationMs: Date.now() - startMs,
        keyName:    req.apiKey ? req.apiKey.name : undefined,
      });
    });

    next();
  });
}

// ---------------------------------------------------------------------------
// DB write logger (called from db.js)
// ---------------------------------------------------------------------------

/**
 * Log a single DML statement (INSERT / UPDATE / DELETE).
 * @param {string} sql — the exact SQL string passed to asqlcmd
 */
function logDbWrite(sql) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  write({
    type:        'db_write',
    description: describeSql(flat),
    sql:         flat.substring(0, 600),
  });
}

/** Returns the reqId for the current async context (used by backup.js). */
function getReqId() {
  const store = als.getStore();
  return store ? store.reqId : null;
}

module.exports = { requestLogger, logDbWrite, getReqId };

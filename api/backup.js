/**
 * backup.js — Pre-change row capture for every write operation
 *
 * Called from db.js execute() BEFORE each INSERT / UPDATE / DELETE so that
 * a full snapshot of the affected rows is written to api-backup.jsonl.
 * The revert script (Revert-KantechChanges.ps1) reads this file and replays
 * the inverse SQL in reverse chronological order.
 *
 * Backup entry shape:
 *   { ts, reqId, operation, table, preChangeRows[], revertSqls[] }
 *
 * Revert SQL is pre-computed at capture time so the revert script is
 * a simple reader — it never needs to reconstruct SQL itself.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { getReqId } = require('./logger');

const LOG_DIR     = process.env.LOG_DIR
  ? process.env.LOG_DIR
  : path.resolve(__dirname, '..', 'logs');
const BACKUP_FILE = path.join(LOG_DIR, 'api-backup.jsonl');

// ---------------------------------------------------------------------------
// Known primary key columns per table.
// Used to build DELETE revert SQL when reversing an INSERT.
// ---------------------------------------------------------------------------
const TABLE_PKS = {
  Card:       ['PkData'],
  CardNumber: ['PkCard', 'CardNumberFormatted'],
  ItemCard:   ['FkDataCard'],
  Door:       ['PkData'],
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function writeEntry(entry) {
  try {
    ensureDir();
    fs.appendFileSync(BACKUP_FILE, JSON.stringify(entry) + '\n');
  } catch (_) { /* never crash the API over a backup failure */ }
}

/** Escape a value back to a SQL literal for revert SQL generation. */
function escVal(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  // Dates returned by ADS look like "MM/DD/YYYY HH:MM:SS AM"
  // Keep them as string literals
  const n = Number(v);
  if (!isNaN(n) && String(v).trim() !== '' && !/[\/\s]/.test(String(v))) return String(n);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/** Build an INSERT SQL from a row object (used to revert a DELETE). */
function buildInsertSql(table, row) {
  const cols = Object.keys(row);
  const vals = cols.map(c => escVal(row[c]));
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')})`;
}

/** Build an UPDATE SQL that restores a row to its pre-change state. */
function buildUpdateRevertSql(table, row, whereClause) {
  const sets = Object.entries(row)
    .map(([c, v]) => `${c} = ${escVal(v)}`)
    .join(', ');
  return `UPDATE ${table} SET ${sets} WHERE ${whereClause}`;
}

// ---------------------------------------------------------------------------
// SQL parsers
// ---------------------------------------------------------------------------

/**
 * Split a SQL VALUES(...) string on commas, respecting quoted strings.
 * Returns an array of raw value tokens (still quoted/unquoted as in SQL).
 */
function splitSqlValues(str) {
  const vals = [];
  let inStr = false, cur = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && !inStr)  { inStr = true;  cur += ch; }
    else if (ch === "'" && inStr) {
      if (str[i + 1] === "'") { cur += "''"; i++; }  // escaped quote inside string
      else { inStr = false; cur += ch; }
    }
    else if (ch === ',' && !inStr) { vals.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  if (cur.trim()) vals.push(cur.trim());
  return vals;
}

function parseInsert(sql) {
  const m = sql.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)\s*$/is);
  if (!m) return null;
  const table   = m[1];
  const cols    = m[2].split(',').map(c => c.trim());
  const rawVals = splitSqlValues(m[3]);
  // Build col→rawValue map (values still in SQL literal form)
  const colMap = {};
  cols.forEach((c, i) => { colMap[c] = rawVals[i] !== undefined ? rawVals[i] : 'NULL'; });
  return { table, cols, colMap };
}

function parseUpdate(sql) {
  const m = sql.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/is);
  if (!m) return null;
  return { table: m[1].trim(), setClause: m[2].trim(), whereClause: m[3].trim() };
}

function parseDelete(sql) {
  const m = sql.match(/^DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/is);
  if (!m) return null;
  return { table: m[1].trim(), whereClause: (m[2] || '').trim() };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Capture pre-change data and write a backup entry BEFORE the SQL runs.
 *
 * @param {string}   sql      - The SQL string about to be executed
 * @param {function} queryFn  - db.query() — used to SELECT affected rows
 */
async function captureAndLog(sql, queryFn) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  const ts   = new Date().toISOString();
  const reqId = getReqId();

  try {

    // -----------------------------------------------------------------------
    // INSERT — nothing exists yet; record the inserted values so we can
    // generate a DELETE revert using the table's primary key columns.
    // -----------------------------------------------------------------------
    const ins = parseInsert(flat);
    if (ins) {
      const pkCols = TABLE_PKS[ins.table] || [];
      let revertSql = null;

      if (pkCols.length) {
        const whereParts = pkCols
          .filter(pk => ins.colMap[pk] !== undefined)
          .map(pk => `${pk} = ${ins.colMap[pk]}`);
        if (whereParts.length) {
          revertSql = `DELETE FROM ${ins.table} WHERE ${whereParts.join(' AND ')}`;
        }
      }

      writeEntry({
        ts, reqId,
        operation:      'INSERT',
        table:          ins.table,
        insertedValues: ins.colMap,   // col → SQL-literal-value
        revertSqls:     revertSql ? [revertSql] : [],
        note:           revertSql ? null : 'No PK mapping found — manual revert required',
      });
      return;
    }

    // -----------------------------------------------------------------------
    // UPDATE — SELECT the rows before they change, build restore SQL.
    // -----------------------------------------------------------------------
    const upd = parseUpdate(flat);
    if (upd) {
      const rows       = await queryFn(`SELECT * FROM ${upd.table} WHERE ${upd.whereClause}`);
      const revertSqls = rows.map(row => buildUpdateRevertSql(upd.table, row, upd.whereClause));

      writeEntry({
        ts, reqId,
        operation:     'UPDATE',
        table:         upd.table,
        where:         upd.whereClause,
        preChangeRows: rows,
        revertSqls,
      });
      return;
    }

    // -----------------------------------------------------------------------
    // DELETE — SELECT the rows before they're gone, build re-INSERT SQL.
    // -----------------------------------------------------------------------
    const del = parseDelete(flat);
    if (del) {
      const rows = del.whereClause
        ? await queryFn(`SELECT * FROM ${del.table} WHERE ${del.whereClause}`)
        : await queryFn(`SELECT * FROM ${del.table}`);
      const revertSqls = rows.map(row => buildInsertSql(del.table, row));

      writeEntry({
        ts, reqId,
        operation:     'DELETE',
        table:         del.table,
        where:         del.whereClause || '(none)',
        preChangeRows: rows,
        revertSqls,
      });
      return;
    }

  } catch (err) {
    // Log the backup failure but never block the actual write
    writeEntry({
      ts, reqId,
      operation: 'BACKUP_ERROR',
      sql:       flat.substring(0, 400),
      error:     err.message,
    });
  }
}

module.exports = { captureAndLog };

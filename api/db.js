/**
 * db.js — ADS (Advantage Database Server) query helper
 *
 * Wraps asqlcmd.exe to execute SQL against the local EntraPass database.
 * Uses execFile (no shell) so connection strings with spaces work correctly.
 */

'use strict';

const { execFile } = require('child_process');
const { parse }    = require('csv-parse/sync');

const ASQLCMD   = process.env.KANTECH_ASQLCMD;
const DATA_DIR  = process.env.KANTECH_DATA_DIR;
const ARCH_DIR  = process.env.KANTECH_ARCHIVE_DIR;

const DATA_CONN = `Data Source=${DATA_DIR};ServerType=ADS_LOCAL_SERVER;TableType=ADT;Collation=GENERAL_VFP_CI_AS_1252;`;
const ARCH_CONN = `Data Source=${ARCH_DIR};ServerType=ADS_LOCAL_SERVER;TableType=ADT;Collation=GENERAL_VFP_CI_AS_1252;`;

/**
 * Escape a value for use in an ADS SQL string literal.
 * Wrap the returned value directly in your SQL: WHERE Name = ${esc(name)}
 */
function esc(val) {
  if (val === null || val === undefined) return 'NULL';
  const n = Number(val);
  if (!isNaN(n) && String(val).trim() !== '') return String(n); // numeric — no quotes needed
  return "'" + String(val).replace(/'/g, "''") + "'";
}

/** Escape a string value unconditionally (even if it looks numeric) */
function escStr(val) {
  if (val === null || val === undefined) return 'NULL';
  return "'" + String(val).replace(/'/g, "''") + "'";
}

/**
 * Run a SELECT query and return an array of plain objects.
 * @param {string} sql        - SQL to execute
 * @param {string} [connStr]  - override connection string (default: DATA_CONN)
 */
function query(sql, connStr) {
  const cs = connStr || DATA_CONN;
  // Collapse whitespace to a single line — asqlcmd can choke on newlines in -Q
  const flatSql = sql.replace(/\s+/g, ' ').trim();

  return new Promise((resolve, reject) => {
    execFile(
      ASQLCMD,
      ['-CS', cs, '-Q', flatSql],
      // latin1 encoding preserves Windows-1252 bytes from ADS without garbling them
      { timeout: 30000, maxBuffer: 50 * 1024 * 1024, encoding: 'latin1' },
      (err, stdout, stderr) => {
        const text = stdout || '';

        // Strip the trailing "Finished. Lines processed = N" line and blanks
        const lines = text
          .split(/\r?\n/)
          .map(l => l.trimEnd())
          .filter(l => l && !/^Finished\./.test(l));

        if (lines.length === 0) {
          // No output — check if asqlcmd itself reported an error
          if (err) return reject(new Error(stderr || err.message));
          return resolve([]);
        }

        // Only a header row = zero results (not an error)
        if (lines.length === 1) return resolve([]);

        try {
          const records = parse(lines.join('\n'), {
            columns:               true,
            skip_empty_lines:      true,
            trim:                  true,
            relax_quotes:          true,
            skip_records_with_error: true,   // tolerate malformed data rows
          });
          resolve(records);
        } catch (parseErr) {
          reject(new Error('CSV parse error: ' + parseErr.message +
                           ' | first line: ' + lines[0]));
        }
      }
    );
  });
}

/**
 * Run a non-SELECT statement (INSERT / UPDATE / DELETE).
 * Rejects if asqlcmd exits non-zero.
 */
function execute(sql, connStr) {
  const cs = connStr || DATA_CONN;
  return new Promise((resolve, reject) => {
    execFile(
      ASQLCMD,
      ['-CS', cs, '-Q', sql],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || stdout || err.message));
        resolve(true);
      }
    );
  });
}

module.exports = { query, execute, esc, escStr, DATA_CONN, ARCH_CONN };

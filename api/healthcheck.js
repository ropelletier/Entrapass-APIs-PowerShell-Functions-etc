/**
 * healthcheck.js — Deep health check with auto-remediation and email alerts
 *
 * Checks:
 *   1. ADS database queryable
 *   2. SmartService Windows service running
 *   3. SmartService HTTP port accepting connections
 *   4. SmartService login (actual auth, not just TCP)
 *   5. EntraPass Gateway service running
 *   6. KantechEventMonitor service running
 *   7. MySQL remote database reachable
 *   8. Disk space on data drive
 *
 * Auto-fix (restarts service if stopped):
 *   - Kantech.SmartService
 *   - EpCeServiceGateway
 *   - KantechEventMonitor
 *
 * Notifications:
 *   - Sends up to 3 failure emails per outage (with cooldown)
 *   - Sends recovery email when a previously-failed check passes
 *
 * Usage:
 *   Mounted at GET /health/deep in server.js
 *   Also runs on a timer (default every 60s) when the API starts.
 *
 *   GET /health/deep          — run all checks, return JSON report
 *   GET /health/deep?fix=0    — check only, skip auto-remediation
 */

'use strict';

const { exec }     = require('child_process');
const net          = require('net');
const os           = require('os');
const nodemailer   = require('nodemailer');

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------
const SMARTSERVICE_PORT = parseInt(process.env.SMARTSERVICE_PORT || '8801', 10);
const CHECK_INTERVAL    = parseInt(process.env.HEALTH_CHECK_INTERVAL || '60', 10) * 1000;
const ALERT_COOLDOWN    = parseInt(process.env.HEALTH_ALERT_COOLDOWN || '300', 10) * 1000;
const DISK_WARN_GB      = parseInt(process.env.HEALTH_DISK_WARN_GB || '5', 10);

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '25', 10);
const SMTP_FROM = process.env.SMTP_FROM;
const SMTP_TO   = process.env.SMTP_TO;

// Services eligible for auto-restart
const RESTARTABLE_SERVICES = {
  smartservice_svc: 'Kantech.SmartService',
  gateway_svc:      'EpCeServiceGateway',
  eventmonitor_svc: 'KantechEventMonitor',
};

// ---------------------------------------------------------------------------
// State tracking
// ---------------------------------------------------------------------------
const MAX_FAILURE_ALERTS = 3;

const state = {
  alertCount: {},   // failure alerts sent per check (resets on recovery)
  lastAlert:  {},   // last alert timestamp per check (for cooldown)
  prevStatus: {},   // previous ok/fail per check (for recovery detection)
};

// ---------------------------------------------------------------------------
// Email helper
// ---------------------------------------------------------------------------
let transporter = null;

function getTransporter() {
  if (!transporter && SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false,
      tls: { rejectUnauthorized: false },
    });
  }
  return transporter;
}

async function sendAlert(subject, body) {
  const t = getTransporter();
  if (!t || !SMTP_TO) return;
  try {
    await t.sendMail({
      from: SMTP_FROM || 'kantech-health@localhost',
      to:   SMTP_TO,
      subject,
      text: body,
    });
    console.log(`[healthcheck] Alert sent: ${subject}`);
  } catch (err) {
    console.error(`[healthcheck] Failed to send alert: ${err.message}`);
  }
}

function shouldAlert(checkName) {
  const count = state.alertCount[checkName] || 0;
  if (count >= MAX_FAILURE_ALERTS) return false;
  const last = state.lastAlert[checkName] || 0;
  return (Date.now() - last) >= ALERT_COOLDOWN;
}

function markAlerted(checkName) {
  state.lastAlert[checkName] = Date.now();
  state.alertCount[checkName] = (state.alertCount[checkName] || 0) + 1;
}

// ---------------------------------------------------------------------------
// Generic Windows service check
// ---------------------------------------------------------------------------
function checkWindowsService(name, svcName) {
  return new Promise((resolve) => {
    exec(`sc query "${svcName}"`, (err, stdout) => {
      if (err || !stdout.includes('RUNNING')) {
        resolve({ name, ok: false, detail: `Windows service "${svcName}" is not running` });
      } else {
        resolve({ name, ok: true, detail: 'Service is running' });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/** ADS database queryable */
async function checkDatabase() {
  const { query } = require('./db');
  try {
    const rows = await query('SELECT TOP 1 PkData FROM Door');
    return { name: 'database', ok: true, detail: `ADS reachable (${rows.length} row)` };
  } catch (err) {
    return { name: 'database', ok: false, detail: err.message };
  }
}

/** SmartService Windows service */
function checkSmartServiceSvc() {
  return checkWindowsService('smartservice_svc', 'Kantech.SmartService');
}

/** SmartService TCP port */
function checkSmartServiceHttp() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ name: 'smartservice_http', ok: false, detail: `Port ${SMARTSERVICE_PORT} not responding (timeout)` });
    }, 5000);

    socket.connect(SMARTSERVICE_PORT, '127.0.0.1', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ name: 'smartservice_http', ok: true, detail: `Port ${SMARTSERVICE_PORT} accepting connections` });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      resolve({ name: 'smartservice_http', ok: false, detail: `Port ${SMARTSERVICE_PORT}: ${err.message}` });
    });
  });
}

/** SmartService login — actually authenticate and get a session key */
async function checkSmartServiceLogin() {
  try {
    const ss = require('./smartservice');
    const key = await ss.refreshSession();
    return { name: 'smartservice_login', ok: true, detail: `Session key obtained (${key.substring(0, 8)}...)` };
  } catch (err) {
    return { name: 'smartservice_login', ok: false, detail: err.message };
  }
}

/** EntraPass Gateway service */
function checkGatewaySvc() {
  return checkWindowsService('gateway_svc', 'EpCeServiceGateway');
}

/** KantechEventMonitor service */
function checkEventMonitorSvc() {
  return checkWindowsService('eventmonitor_svc', 'KantechEventMonitor');
}

/** MySQL remote database connectivity */
async function checkMysql() {
  const host = process.env.MYSQL_HOST;
  const port = parseInt(process.env.MYSQL_PORT || '3306', 10);
  const db   = process.env.MYSQL_DATABASE;
  const user = process.env.MYSQL_USER;
  const pass = process.env.MYSQL_PASSWORD;

  if (!host) return { name: 'mysql', ok: true, detail: 'Skipped (MYSQL_HOST not configured)' };

  let connection;
  try {
    const mysql = require('mysql2/promise');
    connection = await mysql.createConnection({
      host, port, database: db, user, password: pass,
      connectTimeout: 5000,
    });
    await connection.execute('SELECT 1');
    return { name: 'mysql', ok: true, detail: `MySQL reachable at ${host}:${port}` };
  } catch (err) {
    return { name: 'mysql', ok: false, detail: `MySQL ${host}:${port}: ${err.message}` };
  } finally {
    if (connection) try { await connection.end(); } catch (_) {}
  }
}

/** Disk space on the data drive */
function checkDiskSpace() {
  // Extract drive letter from KANTECH_DATA_DIR (e.g. "C:\...")
  const dataDir = process.env.KANTECH_DATA_DIR || 'C:\\';
  const drive = dataDir.charAt(0).toUpperCase();

  return new Promise((resolve) => {
    exec(`wmic logicaldisk where "DeviceID='${drive}:'" get FreeSpace /format:value`, { timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve({ name: 'disk_space', ok: false, detail: `Could not check disk: ${err.message}` });
        return;
      }
      const match = stdout.match(/FreeSpace=(\d+)/);
      if (!match) {
        resolve({ name: 'disk_space', ok: false, detail: 'Could not parse free space' });
        return;
      }
      const freeGB = parseInt(match[1], 10) / (1024 * 1024 * 1024);
      const ok = freeGB >= DISK_WARN_GB;
      resolve({
        name: 'disk_space',
        ok,
        detail: `${drive}: drive — ${freeGB.toFixed(1)} GB free${ok ? '' : ` (below ${DISK_WARN_GB} GB threshold)`}`,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Auto-remediation
// ---------------------------------------------------------------------------

/**
 * Attempt to start a Windows service by name.
 */
function startService(svcName) {
  return new Promise((resolve) => {
    console.log(`[healthcheck] Attempting to start ${svcName}...`);
    exec(`net start "${svcName}"`, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ service: svcName, attempted: true, success: false, detail: stderr || stdout || err.message });
      } else {
        console.log(`[healthcheck] ${svcName} started successfully`);
        resolve({ service: svcName, attempted: true, success: true, detail: 'Service started' });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Main health check
// ---------------------------------------------------------------------------

/**
 * Run all health checks and optionally auto-fix.
 * @param {boolean} autoFix - attempt to restart failed services
 * @returns {object} { ok, time, checks[], remediations[] }
 */
async function runHealthCheck(autoFix = true) {
  const results = await Promise.all([
    checkDatabase(),
    checkSmartServiceSvc(),
    checkSmartServiceHttp(),
    checkSmartServiceLogin(),
    checkGatewaySvc(),
    checkEventMonitorSvc(),
    checkMysql(),
    checkDiskSpace(),
  ]);

  const remediations = [];

  // Auto-fix any restartable services that are down
  if (autoFix) {
    for (const [checkName, svcName] of Object.entries(RESTARTABLE_SERVICES)) {
      const check = results.find(r => r.name === checkName);
      if (check && !check.ok) {
        const fix = await startService(svcName);
        remediations.push(fix);
      }
    }

    // If SmartService was restarted, also re-check the HTTP and login checks
    const ssRestart = remediations.find(r => r.service === 'Kantech.SmartService');
    if (ssRestart && ssRestart.success) {
      await new Promise(r => setTimeout(r, 5000));
      const rechecks = await Promise.all([
        checkSmartServiceSvc(),
        checkSmartServiceHttp(),
        checkSmartServiceLogin(),
      ]);
      for (const rc of rechecks) {
        const orig = results.find(r => r.name === rc.name);
        if (orig) { orig.ok = rc.ok; orig.detail = rc.detail; orig.remediated = true; }
      }
    }

    // Re-check other restarted services
    for (const [checkName, svcName] of Object.entries(RESTARTABLE_SERVICES)) {
      if (svcName === 'Kantech.SmartService') continue; // already handled above
      const fix = remediations.find(r => r.service === svcName && r.success);
      if (fix) {
        await new Promise(r => setTimeout(r, 3000));
        const rc = await checkWindowsService(checkName, svcName);
        const orig = results.find(r => r.name === checkName);
        if (orig) { orig.ok = rc.ok; orig.detail = rc.detail; orig.remediated = true; }
      }
    }
  }

  // Notifications — alert on failure, notify on recovery
  for (const check of results) {
    const prev = state.prevStatus[check.name];

    if (!check.ok && shouldAlert(check.name)) {
      const fixNote = remediations.length
        ? `\nAuto-remediation attempted:\n${remediations.map(r => `  ${r.service}: ${r.success ? 'OK' : 'FAILED'} — ${r.detail}`).join('\n')}`
        : '';
      await sendAlert(
        `[Kantech] HEALTH CHECK FAILED: ${check.name}`,
        `Check "${check.name}" is failing.\n\n` +
        `Detail: ${check.detail}\n` +
        `Time: ${new Date().toISOString()}\n` +
        `Host: ${os.hostname()}\n` +
        fixNote
      );
      markAlerted(check.name);
    }

    if (check.ok && prev === false) {
      await sendAlert(
        `[Kantech] RECOVERED: ${check.name}`,
        `Check "${check.name}" has recovered.\n\n` +
        `Detail: ${check.detail}\n` +
        `Time: ${new Date().toISOString()}\n` +
        `Host: ${os.hostname()}`
      );
      // Reset failure alert counter so next outage gets fresh alerts
      state.alertCount[check.name] = 0;
      state.lastAlert[check.name] = 0;
    }

    state.prevStatus[check.name] = check.ok;
  }

  const nowOk = results.every(r => r.ok);

  return {
    ok:   nowOk,
    time: new Date().toISOString(),
    checks: results,
    remediations: remediations.length ? remediations : undefined,
  };
}

// ---------------------------------------------------------------------------
// Express route handler
// ---------------------------------------------------------------------------

function deepHealthRoute(req, res) {
  const autoFix = req.query.fix !== '0';
  runHealthCheck(autoFix)
    .then(report => res.status(report.ok ? 200 : 503).json(report))
    .catch(err => res.status(500).json({ ok: false, error: err.message }));
}

// ---------------------------------------------------------------------------
// Background timer
// ---------------------------------------------------------------------------
let _interval = null;

function startBackgroundChecks() {
  if (_interval) return;
  console.log(`[healthcheck] Background checks every ${CHECK_INTERVAL / 1000}s`);
  // Initial check after 10s (let server finish starting)
  setTimeout(() => runHealthCheck(true).catch(() => {}), 10000);
  _interval = setInterval(() => runHealthCheck(true).catch(() => {}), CHECK_INTERVAL);
}

function stopBackgroundChecks() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { deepHealthRoute, runHealthCheck, startBackgroundChecks, stopBackgroundChecks };

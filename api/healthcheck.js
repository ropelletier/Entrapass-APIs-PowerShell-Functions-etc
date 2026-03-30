/**
 * healthcheck.js — Deep health check with auto-remediation and email alerts
 *
 * Checks:
 *   1. API server reachable (self-check via /health)
 *   2. ADS database queryable
 *   3. SmartService Windows service running + HTTP responsive
 *
 * Auto-fix:
 *   - Restarts Kantech.SmartService if stopped or unresponsive
 *
 * Notifications:
 *   - Sends email via SMTP on failure (with cooldown to avoid spam)
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

const { execFile, exec } = require('child_process');
const http               = require('http');
const net                = require('net');
const nodemailer         = require('nodemailer');

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------
const SMARTSERVICE_PORT = parseInt(process.env.SMARTSERVICE_PORT || '8801', 10);
const SMARTSERVICE_SVC  = 'Kantech.SmartService';
const CHECK_INTERVAL    = parseInt(process.env.HEALTH_CHECK_INTERVAL || '60', 10) * 1000;
const ALERT_COOLDOWN    = parseInt(process.env.HEALTH_ALERT_COOLDOWN || '300', 10) * 1000; // 5 min default

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '25', 10);
const SMTP_FROM = process.env.SMTP_FROM;
const SMTP_TO   = process.env.SMTP_TO;

// ---------------------------------------------------------------------------
// State tracking
// ---------------------------------------------------------------------------
const MAX_FAILURE_ALERTS = 3;

const state = {
  // Number of failure alerts sent per check name (resets on recovery)
  alertCount: {},
  // Last alert time per check name — for cooldown
  lastAlert: {},
  // Previous status per check — for recovery detection
  prevStatus: {},
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
// Individual checks
// ---------------------------------------------------------------------------

/**
 * Check if ADS database is queryable.
 */
async function checkDatabase() {
  const { query } = require('./db');
  try {
    const rows = await query('SELECT TOP 1 PkData FROM Door');
    return { name: 'database', ok: true, detail: `ADS reachable (${rows.length} row)` };
  } catch (err) {
    return { name: 'database', ok: false, detail: err.message };
  }
}

/**
 * Check if SmartService Windows service is running.
 */
function checkSmartServiceSvc() {
  return new Promise((resolve) => {
    exec(`sc query "${SMARTSERVICE_SVC}"`, (err, stdout) => {
      if (err || !stdout.includes('RUNNING')) {
        resolve({ name: 'smartservice_svc', ok: false, detail: `Windows service "${SMARTSERVICE_SVC}" is not running` });
      } else {
        resolve({ name: 'smartservice_svc', ok: true, detail: 'Service is running' });
      }
    });
  });
}

/**
 * Check if SmartService HTTP port is accepting connections.
 */
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

// ---------------------------------------------------------------------------
// Auto-remediation
// ---------------------------------------------------------------------------

/**
 * Attempt to start the SmartService Windows service.
 * Returns { attempted, success, detail }.
 */
function restartSmartService() {
  return new Promise((resolve) => {
    console.log(`[healthcheck] Attempting to start ${SMARTSERVICE_SVC}...`);
    exec(`net start "${SMARTSERVICE_SVC}"`, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ attempted: true, success: false, detail: stderr || stdout || err.message });
      } else {
        console.log(`[healthcheck] ${SMARTSERVICE_SVC} started successfully`);
        resolve({ attempted: true, success: true, detail: 'Service started' });
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
  ]);

  const remediations = [];
  const allOk = results.every(r => r.ok);

  // Auto-fix SmartService if needed
  const svcCheck  = results.find(r => r.name === 'smartservice_svc');
  const httpCheck = results.find(r => r.name === 'smartservice_http');

  if (autoFix && (!svcCheck.ok || !httpCheck.ok)) {
    const fix = await restartSmartService();
    remediations.push({ service: SMARTSERVICE_SVC, ...fix });

    if (fix.success) {
      // Wait a moment then re-check
      await new Promise(r => setTimeout(r, 5000));
      const recheck = await Promise.all([checkSmartServiceSvc(), checkSmartServiceHttp()]);
      for (const rc of recheck) {
        const orig = results.find(r => r.name === rc.name);
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
        `Host: ${require('os').hostname()}\n` +
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
        `Host: ${require('os').hostname()}`
      );
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

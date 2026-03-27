/**
 * smartservice.js — SmartService REST API client with session management
 *
 * Uses the PowerShell bridge (smartservice-login.ps1) to authenticate via
 * ENCRYPTEDLOGIN and obtain a session key (sdKey). Caches the session and
 * refreshes it when calls fail with auth errors.
 *
 * Card write operations (create/update/delete) go through SmartService so
 * changes are visible in the EntraPass workstation immediately.
 */

'use strict';

const { execFile } = require('child_process');
const http         = require('http');
const path         = require('path');

const SMARTSERVICE_BASE = process.env.SMARTSERVICE_URI || 'http://localhost:8801/SmartService';
const LOGIN_SCRIPT      = path.join(__dirname, 'smartservice-login.ps1');

// Session cache
let cachedSession = null;   // { key, operator, obtainedAt }
const SESSION_TTL = 25 * 60 * 1000;  // refresh after 25 min (SmartService timeout is ~30 min)

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Get a valid session key, logging in if needed.
 */
async function getSessionKey() {
  if (cachedSession && (Date.now() - cachedSession.obtainedAt) < SESSION_TTL) {
    return cachedSession.key;
  }
  return refreshSession();
}

/**
 * Call the PowerShell bridge to get a new session key.
 */
function refreshSession() {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-ExecutionPolicy', 'Bypass', '-File', LOGIN_SCRIPT],
      {
        timeout: 30000,
        env: { ...process.env },   // inherits KANTECH_ADMIN_USER, KANTECH_ADMIN_PASSWORD from .env
      },
      (err, stdout, stderr) => {
        if (err) {
          cachedSession = null;
          return reject(new Error(`SmartService login failed: ${stderr || stdout || err.message}`));
        }
        try {
          const result = JSON.parse(stdout.trim());
          if (result.error) {
            cachedSession = null;
            return reject(new Error(`SmartService login error: ${result.error}`));
          }
          cachedSession = {
            key: result.sessionKey,
            operator: result.operator,
            obtainedAt: Date.now(),
          };
          console.log(`SmartService session obtained: ${result.sessionKey.substring(0, 8)}... (${result.operator})`);
          resolve(cachedSession.key);
        } catch (parseErr) {
          cachedSession = null;
          reject(new Error(`SmartService login parse error: ${parseErr.message} | output: ${stdout}`));
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// HTTP helper for SmartService REST calls
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request to SmartService.
 * @param {string} method  - GET, PUT, POST, DELETE
 * @param {string} path    - e.g. "Cards/901"
 * @param {object} [opts]  - { query: {}, body: string, contentType: string }
 * @returns {Promise<{status: number, body: string}>}
 */
function ssRequest(method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SMARTSERVICE_BASE}/${urlPath}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        url.searchParams.set(k, v);
      }
    }

    const reqOpts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {},
    };
    if (opts.body !== undefined) {
      reqOpts.headers['Content-Type'] = opts.contentType || 'application/xml';
      reqOpts.headers['Content-Length'] = Buffer.byteLength(opts.body);
    } else if (method === 'PUT' || method === 'POST') {
      reqOpts.headers['Content-Length'] = 0;
    }

    const req = http.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('SmartService request timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/**
 * SmartService REST call with auto session management.
 * Retries once with a fresh session if the first attempt fails with auth error.
 */
async function ssCall(method, urlPath, opts = {}) {
  const key = await getSessionKey();
  const query = { ...(opts.query || {}), sdKey: key };

  let res = await ssRequest(method, urlPath, { ...opts, query });

  // If auth failed (session expired), refresh and retry once
  if (res.status === 401 || res.status === 403 ||
      (res.body && res.body.includes('SessionKey'))) {
    const newKey = await refreshSession();
    query.sdKey = newKey;
    res = await ssRequest(method, urlPath, { ...opts, query });
  }

  return res;
}

// ---------------------------------------------------------------------------
// Card operations via SmartService
// ---------------------------------------------------------------------------

/**
 * Build Card XML for SmartService PUT/POST.
 * @param {number} id           - Card PkData (cardholder ID)
 * @param {object} fields       - { CardNumber1: "8006:12345", DisplayCardNumber1: "True", ... }
 */
function buildCardXml(id, fields) {
  let xml = '<?xml version="1.0" encoding="utf-8"?><Card>';
  xml += `<ID>${id}</ID>`;
  for (const [key, value] of Object.entries(fields)) {
    xml += `<${key}>${escapeXml(String(value))}</${key}>`;
  }
  xml += '</Card>';
  return xml;
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Get a card from SmartService.
 */
async function getCard(id) {
  const res = await ssCall('GET', `Cards/${id}`, {
    query: { shortReturn: '0', includeLastAccess: '0' }
  });
  if (res.status !== 200) {
    throw new Error(`SmartService GET Cards/${id} returned ${res.status}: ${res.body}`);
  }
  return res.body;
}

/**
 * Update a card via SmartService.
 * @param {number} id      - Card PkData
 * @param {object} fields  - Card XML fields to set
 * @returns {number} The card ID on success
 */
async function updateCard(id, fields) {
  const xml = buildCardXml(id, fields);
  const res = await ssCall('PUT', `Cards/${id}`, { body: xml });
  if (res.status !== 200) {
    throw new Error(`SmartService PUT Cards/${id} returned ${res.status}: ${res.body}`);
  }
  // Response is <int>id</int>
  const match = res.body.match(/<int>(\d+)<\/int>/);
  return match ? parseInt(match[1]) : id;
}

/**
 * Create a card via SmartService.
 * @param {number} id      - Card PkData
 * @param {object} fields  - Card XML fields
 * @returns {number} The card ID on success
 */
async function createCard(id, fields) {
  const xml = buildCardXml(id, fields);
  const res = await ssCall('POST', `Cards/${id}`, { body: xml });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`SmartService POST Cards/${id} returned ${res.status}: ${res.body}`);
  }
  const match = res.body.match(/<int>(\d+)<\/int>/);
  return match ? parseInt(match[1]) : id;
}

/**
 * Delete a card via SmartService.
 */
async function deleteCard(id) {
  const res = await ssCall('DELETE', `Cards/${id}`);
  if (res.status !== 200) {
    throw new Error(`SmartService DELETE Cards/${id} returned ${res.status}: ${res.body}`);
  }
  return true;
}

module.exports = {
  getSessionKey,
  refreshSession,
  ssCall,
  getCard,
  updateCard,
  createCard,
  deleteCard,
  buildCardXml,
};

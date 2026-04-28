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
 * Log out the current session to free the SmartService connection slot.
 * Safe to call even if no session exists.
 */
async function logout() {
  if (!cachedSession) return;
  const oldKey = cachedSession.key;
  cachedSession = null;
  try {
    await ssRequest('GET', 'Logout', { query: { sdKey: oldKey } });
    console.log(`SmartService session logged out: ${oldKey.substring(0, 8)}...`);
  } catch (_) { /* best-effort — don't block on logout failures */ }
}

/**
 * Call the PowerShell bridge to get a new session key.
 * Logs out any existing session first to avoid exhausting SmartService's connection limit.
 */
async function refreshSession() {
  await logout();
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
// Constants
// ---------------------------------------------------------------------------
const GATEWAY_SITE_ID      = 67;
const DEFAULT_CARD_TYPE    = 18;  // Employee
const ALWAYS_VALID_SCHEDULE = 25;

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Build Card XML with flat key-value fields only.
 * Used by card-slot operations (CardNumber1, CardState1, etc.)
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

/**
 * Build Card XML with flat fields AND raw XML fragments (for nested structures).
 * @param {number} id            - Card PkData
 * @param {object} fields        - Flat key-value fields
 * @param {string[]} fragments   - Pre-built XML fragments (CardAccessLevels, CardDoorAccessList)
 */
function buildCardXmlFull(id, fields, fragments = []) {
  let xml = '<?xml version="1.0" encoding="utf-8"?><Card>';
  xml += `<ID>${id}</ID>`;
  for (const [key, value] of Object.entries(fields)) {
    xml += `<${key}>${escapeXml(String(value))}</${key}>`;
  }
  for (const frag of fragments) {
    xml += frag;
  }
  xml += '</Card>';
  return xml;
}

/**
 * Build <CardAccessLevels> XML fragment for a single primary access level.
 * @param {number} accessLevelId  - Access level PkData (0 or null to clear)
 * @returns {string} XML fragment
 */
function buildAccessLevelsFragment(accessLevelId) {
  if (!accessLevelId) return '<CardAccessLevels/>';
  return '<CardAccessLevels><CardAccessLevel>' +
    `<GatewaySiteID>${GATEWAY_SITE_ID}</GatewaySiteID>` +
    `<AccessLevelID>${accessLevelId}</AccessLevelID>` +
    '<CardSecondaryAccessLevels/>' +
    '</CardAccessLevel></CardAccessLevels>';
}

/**
 * Build <CardDoorAccessList> XML fragment from an array of door exceptions.
 * @param {Array<{doorId: number, scheduleId: number, prevent: boolean}>} exceptions
 * @returns {string} XML fragment
 */
function buildDoorAccessFragment(exceptions) {
  if (!exceptions || !exceptions.length) return '<CardDoorAccessList/>';
  let xml = '<CardDoorAccessList>';
  for (const ex of exceptions) {
    xml += '<CardDoorAccess>' +
      `<DoorID>${ex.doorId}</DoorID>` +
      `<ScheduleID>${ex.scheduleId || ALWAYS_VALID_SCHEDULE}</ScheduleID>` +
      `<Prevent>${ex.prevent ? 'True' : 'False'}</Prevent>` +
      `<SiteID>${GATEWAY_SITE_ID}</SiteID>` +
      '</CardDoorAccess>';
  }
  xml += '</CardDoorAccessList>';
  return xml;
}

/**
 * Build AccessLevel XML for SmartService POST/PUT AccessLevels/{id}.
 */
function buildAccessLevelXml(id, name, description, allValid = false) {
  return '<?xml version="1.0" encoding="utf-8"?><AccessLevel>' +
    `<GatewaySiteID>${GATEWAY_SITE_ID}</GatewaySiteID>` +
    `<AllValid>${allValid ? 'True' : 'False'}</AllValid>` +
    `<PrimaryName>${escapeXml(name)}</PrimaryName>` +
    `<SecondaryName>${escapeXml(description || name)}</SecondaryName>` +
    '<AccessLevelItems/>' +
    `<ID>${id}</ID>` +
    '</AccessLevel>';
}

// ---------------------------------------------------------------------------
// XML parsers — extract structured data from GET Cards response
// ---------------------------------------------------------------------------

/**
 * Parse the primary access level ID from Card XML.
 * @returns {number|null} Access level ID or null if none
 */
function parseCardAccessLevel(xml) {
  const m = xml.match(/<CardAccessLevels>[\s\S]*?<AccessLevelID>(\d+)<\/AccessLevelID>/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Parse door exceptions from Card XML.
 * @returns {Array<{doorId: number, scheduleId: number, prevent: boolean}>}
 */
function parseCardDoorAccess(xml) {
  const listMatch = xml.match(/<CardDoorAccessList>([\s\S]*?)<\/CardDoorAccessList>/);
  if (!listMatch) return [];
  const entries = [];
  const re = /<CardDoorAccess>([\s\S]*?)<\/CardDoorAccess>/g;
  let m;
  while ((m = re.exec(listMatch[1])) !== null) {
    const block = m[1];
    const doorId     = (block.match(/<DoorID>(\d+)<\/DoorID>/)     || [])[1];
    const scheduleId = (block.match(/<ScheduleID>(\d+)<\/ScheduleID>/) || [])[1];
    const prevent    = (block.match(/<Prevent>(\w+)<\/Prevent>/)   || [])[1];
    if (doorId) {
      entries.push({
        doorId:     parseInt(doorId, 10),
        scheduleId: parseInt(scheduleId || ALWAYS_VALID_SCHEDULE, 10),
        prevent:    prevent === 'True',
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Fault checking — SmartService returns 200 even on errors
// ---------------------------------------------------------------------------

/**
 * Check a SmartService response for StandardFault XML and throw if found.
 * @param {{status: number, body: string}} res
 * @param {string} context - e.g. "POST Cards/907"
 */
function checkFault(res, context) {
  if (res.body && res.body.includes('StandardFault')) {
    const descMatch = res.body.match(/<FirstLanguageErrorDescription>([^<]*)<\/FirstLanguageErrorDescription>/);
    const msgMatch  = res.body.match(/<Message>([^<]*)<\/Message>/);
    const msg = descMatch ? descMatch[1] : (msgMatch ? msgMatch[1] : 'Unknown SmartService error');
    throw new Error(`SmartService ${context}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Card operations via SmartService
// ---------------------------------------------------------------------------

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
  checkFault(res, `GET Cards/${id}`);
  return res.body;
}

/**
 * Update a card via SmartService (flat fields only — card slots, etc.)
 * WARNING: Do NOT include UserName in fields — it creates a duplicate record.
 */
async function updateCard(id, fields) {
  const xml = buildCardXml(id, fields);
  const res = await ssCall('PUT', `Cards/${id}`, { body: xml });
  if (res.status !== 200) {
    throw new Error(`SmartService PUT Cards/${id} returned ${res.status}: ${res.body}`);
  }
  checkFault(res, `PUT Cards/${id}`);
  const match = res.body.match(/<int>(\d+)<\/int>/);
  return match ? parseInt(match[1]) : id;
}

/**
 * Update a card via SmartService with full XML (flat fields + XML fragments).
 * Used for access level and door exception changes.
 * WARNING: Do NOT include UserName in fields — it creates a duplicate record.
 */
async function updateCardFull(id, fields, fragments) {
  const xml = buildCardXmlFull(id, fields, fragments);
  const res = await ssCall('PUT', `Cards/${id}`, { body: xml });
  if (res.status !== 200) {
    throw new Error(`SmartService PUT Cards/${id} returned ${res.status}: ${res.body}`);
  }
  checkFault(res, `PUT Cards/${id}`);
  const match = res.body.match(/<int>(\d+)<\/int>/);
  return match ? parseInt(match[1]) : id;
}

/**
 * Create a card/user via SmartService.
 * Accepts either flat fields or full XML string.
 */
async function createCard(id, fieldsOrXml) {
  const xml = typeof fieldsOrXml === 'string'
    ? fieldsOrXml
    : buildCardXml(id, fieldsOrXml);
  const res = await ssCall('POST', `Cards/${id}`, { body: xml });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`SmartService POST Cards/${id} returned ${res.status}: ${res.body}`);
  }
  checkFault(res, `POST Cards/${id}`);
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
  checkFault(res, `DELETE Cards/${id}`);
  return true;
}

// ---------------------------------------------------------------------------
// Access level operations via SmartService
// ---------------------------------------------------------------------------

/**
 * Create an access level via SmartService POST AccessLevels/{id}.
 */
async function createAccessLevel(id, name, description, allValid = false) {
  const xml = buildAccessLevelXml(id, name, description, allValid);
  const res = await ssCall('POST', `AccessLevels/${id}`, { body: xml });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`SmartService POST AccessLevels/${id} returned ${res.status}: ${res.body}`);
  }
  checkFault(res, `POST AccessLevels/${id}`);
  const match = res.body.match(/<int>(\d+)<\/int>/);
  return match ? parseInt(match[1]) : id;
}

/**
 * Update an access level via SmartService PUT AccessLevels/{id}.
 */
async function updateAccessLevel(id, name, description) {
  const xml = buildAccessLevelXml(id, name, description);
  const res = await ssCall('PUT', `AccessLevels/${id}`, { body: xml });
  if (res.status !== 200) {
    throw new Error(`SmartService PUT AccessLevels/${id} returned ${res.status}: ${res.body}`);
  }
  checkFault(res, `PUT AccessLevels/${id}`);
  return true;
}

module.exports = {
  // Session
  getSessionKey,
  refreshSession,
  logout,
  ssCall,
  // Card CRUD
  getCard,
  updateCard,
  updateCardFull,
  createCard,
  deleteCard,
  // Card XML
  buildCardXml,
  buildCardXmlFull,
  buildAccessLevelsFragment,
  buildDoorAccessFragment,
  // Card XML parsing
  parseCardAccessLevel,
  parseCardDoorAccess,
  // Access level CRUD
  createAccessLevel,
  updateAccessLevel,
  // Constants
  GATEWAY_SITE_ID,
  DEFAULT_CARD_TYPE,
  ALWAYS_VALID_SCHEDULE,
};

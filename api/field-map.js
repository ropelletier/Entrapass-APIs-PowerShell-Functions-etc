/**
 * field-map.js — Custom field name mapping for cardInfo1–cardInfo5
 *
 * Edit api/field-map.json to rename cardInfo fields in API responses and requests.
 * Changes take effect after restarting the service.
 *
 * Example field-map.json:
 *   { "cardInfo1": "powerschool_id", "cardInfo2": "badge_number" }
 *
 * With that config:
 *   GET  /users  → response uses "powerschool_id" instead of "cardInfo1"
 *   POST /users  → body accepts "powerschool_id", writes to cardInfo1
 *   PUT  /users/:id → body accepts "powerschool_id", writes to cardInfo1
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const FIELDS   = ['cardInfo1', 'cardInfo2', 'cardInfo3', 'cardInfo4', 'cardInfo5'];
const MAP_FILE = path.join(__dirname, 'field-map.json');

// Load once at startup
let _raw = {};
try {
  if (fs.existsSync(MAP_FILE)) {
    _raw = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
  }
} catch (e) {
  console.warn('[field-map] Could not load field-map.json:', e.message);
}

// canonical → display name  (e.g. cardInfo1 → powerschool_id)
const outMap = {};
// display name → canonical  (e.g. powerschool_id → cardInfo1)
const inMap  = {};

for (const field of FIELDS) {
  const custom = _raw[field];
  if (custom && custom !== field) {
    outMap[field]  = custom;
    inMap[custom]  = field;
  }
}

/**
 * Rename cardInfo keys in an outbound cardInfo object.
 * { cardInfo1: 'abc' } → { powerschool_id: 'abc' }
 */
function mapOutbound(cardInfoObj) {
  if (!Object.keys(outMap).length) return cardInfoObj;
  const result = {};
  for (const [k, v] of Object.entries(cardInfoObj)) {
    result[outMap[k] || k] = v;
  }
  return result;
}

/**
 * Normalise inbound request body: replace custom names with canonical cardInfoN keys.
 * { powerschool_id: 'abc' } → { cardInfo1: 'abc' }
 * Leaves all other keys untouched.
 */
function mapInbound(body) {
  if (!Object.keys(inMap).length) return body;
  const result = Object.assign({}, body);
  for (const [custom, canonical] of Object.entries(inMap)) {
    if (custom in result) {
      result[canonical] = result[custom];
      delete result[custom];
    }
  }
  return result;
}

module.exports = { mapOutbound, mapInbound };

/**
 * keys.js — API key store
 *
 * Keys are stored in api-keys.json (excluded from git).
 * The raw key is shown exactly once on creation; only its SHA-256 hash is stored.
 *
 * Key format:
 *   { id, name, keyHash, createdAt, expiresAt, active }
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { v4: uuidv4 } = require('uuid');

const KEYS_FILE = path.join(__dirname, 'api-keys.json');

function loadKeys() {
  if (!fs.existsSync(KEYS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveKeys(keys) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf8');
}

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Create a new API key.
 * @param {string} name   - human-readable label
 * @param {number|null} days - expiry in days from now, or null for no expiry
 * @returns {object}  key entry with .key = raw key (shown once only)
 */
function createKey(name, days) {
  const raw     = 'kntk_' + crypto.randomBytes(24).toString('hex');
  const now     = new Date();
  const expires = days ? new Date(now.getTime() + days * 86_400_000) : null;

  const entry = {
    id:        uuidv4(),
    name:      String(name),
    keyHash:   hashKey(raw),
    createdAt: now.toISOString(),
    expiresAt: expires ? expires.toISOString() : null,
    active:    true,
  };

  const keys = loadKeys();
  keys.push(entry);
  saveKeys(keys);

  return { ...entry, key: raw };  // raw key only returned here, never stored
}

/**
 * Validate a raw key string.
 * Returns the matching key entry (without keyHash) or null.
 */
function validateKey(rawKey) {
  const hash = hashKey(rawKey);
  const now  = new Date();
  const keys = loadKeys();
  const match = keys.find(k =>
    k.active &&
    k.keyHash === hash &&
    (!k.expiresAt || new Date(k.expiresAt) > now)
  );
  if (!match) return null;
  const { keyHash, ...safe } = match;
  return safe;
}

/**
 * Revoke a key by its ID.
 * Returns true if found, false if not found.
 */
function revokeKey(id) {
  const keys = loadKeys();
  const idx  = keys.findIndex(k => k.id === id);
  if (idx === -1) return false;
  keys[idx].active = false;
  saveKeys(keys);
  return true;
}

/**
 * List all keys (hashes stripped for safety).
 */
function listKeys() {
  return loadKeys().map(({ keyHash, ...k }) => k);
}

module.exports = { createKey, validateKey, revokeKey, listKeys, loadKeys };

/**
 * auth.js — API key middleware
 *
 * Clients must send:  X-Api-Key: kntk_<hex>
 * Invalid or expired keys get 401/403.
 */

'use strict';

const { validateKey } = require('./keys');

function requireApiKey(req, res, next) {
  const raw = req.headers['x-api-key'];
  if (!raw) {
    return res.status(401).json({ error: 'Missing X-Api-Key header' });
  }

  const key = validateKey(raw);
  if (!key) {
    return res.status(403).json({ error: 'Invalid or expired API key' });
  }

  req.apiKey = key;  // available to route handlers if needed
  next();
}

module.exports = { requireApiKey };

/**
 * routes/admin.js — API key management endpoints
 *
 * GET    /api/v1/admin/keys          list all keys (hashes not shown)
 * POST   /api/v1/admin/keys          create a new key
 * DELETE /api/v1/admin/keys/:id      revoke a key
 *
 * Any valid API key can access these endpoints.
 * To create the FIRST key, use the CLI:
 *   node manage-keys.js create "My App" 365
 */

'use strict';

const router = require('express').Router();
const { createKey, listKeys, revokeKey } = require('../keys');

// GET /api/v1/admin/keys
router.get('/keys', (req, res) => {
  const keys = listKeys();
  res.json({ count: keys.length, keys });
});

// POST /api/v1/admin/keys
// Body: { name: "App Name", days: 365 }   (days optional — omit for no expiry)
router.post('/keys', (req, res) => {
  const { name, days } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const result = createKey(name, days ? parseInt(days, 10) : null);
  res.status(201).json({
    id:        result.id,
    name:      result.name,
    key:       result.key,
    createdAt: result.createdAt,
    expiresAt: result.expiresAt,
    note:      'Store this key securely — it will NOT be shown again',
  });
});

// DELETE /api/v1/admin/keys/:id
router.delete('/keys/:id', (req, res) => {
  const ok = revokeKey(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Key not found' });
  res.json({ ok: true, revoked: req.params.id });
});

module.exports = router;

/**
 * server.js — Kantech EntraPass REST API
 *
 * Reads .env from the parent directory (C:\Projects\Kantech\.env).
 * Queries the local EntraPass ADS database directly via asqlcmd.exe.
 *
 * Base URL:  http://<host>:3000/api/v1/
 *
 * All endpoints (except /health) require:
 *   Header:  X-Api-Key: kntk_<your-key>
 *
 * Create your first key:
 *   cd C:\Projects\Kantech\api
 *   node manage-keys.js create "Admin" 365
 */

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const express       = require('express');
const { requireApiKey } = require('./auth');
const { requestLogger } = require('./logger');

const app  = express();
const PORT = process.env.API_PORT || 3000;

app.use(express.json());
app.use(requestLogger);

// ---------------------------------------------------------------------------
// Health check — no auth
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), service: 'kantech-api' });
});

// ---------------------------------------------------------------------------
// Protected routes
// ---------------------------------------------------------------------------
app.use('/api/v1',        requireApiKey, require('./routes/lookup'));
app.use('/api/v1/users',  requireApiKey, require('./routes/users'));
app.use('/api/v1/cards',  requireApiKey, require('./routes/cards'));
app.use('/api/v1/events', requireApiKey, require('./routes/events'));
app.use('/api/v1/doors',  requireApiKey, require('./routes/doors'));
app.use('/api/v1/admin',  requireApiKey, require('./routes/admin'));

// ---------------------------------------------------------------------------
// 404 catch-all
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log('');
  console.log('Kantech API started');
  console.log(`  Port:    ${PORT}`);
  console.log(`  DataDir: ${process.env.KANTECH_DATA_DIR}`);
  console.log(`  ArchDir: ${process.env.KANTECH_ARCHIVE_DIR}`);
  console.log('');
  console.log('  GET  /api/v1/users                       all users');
  console.log('  GET  /api/v1/users?name=Smith             name search');
  console.log('  GET  /api/v1/users?card=00001234          by card number');
  console.log('  GET  /api/v1/users/:id                    by ID');
  console.log('  GET  /api/v1/users/:id/cards              cards for user');
  console.log('  POST /api/v1/users                        create user');
  console.log('  PUT  /api/v1/users/:id                    update user');
  console.log('');
  console.log('  GET  /api/v1/cards                        all cards');
  console.log('  GET  /api/v1/cards?user_id=123            cards for user');
  console.log('  GET  /api/v1/cards?lost=true              lost/stolen cards');
  console.log('  GET  /api/v1/cards/:number                by card number');
  console.log('  POST /api/v1/cards                        assign new card');
  console.log('  PUT  /api/v1/cards/:number                update card');
  console.log('');
  console.log('  GET  /api/v1/events                       today\'s events');
  console.log('  GET  /api/v1/events?date=2026-03-22       events by date');
  console.log('  GET  /api/v1/events?user_id=123           events by user');
  console.log('');
  console.log('  GET  /api/v1/doors                        all doors with current mode');
  console.log('  GET  /api/v1/doors/:id                    single door');
  console.log('  POST /api/v1/doors/:id/unlock             unlock for N seconds then relock');
  console.log('  POST /api/v1/doors/:id/lock               lock for N seconds then restore');
  console.log('  POST /api/v1/doors/:id/normal             cancel override immediately');
  console.log('');
  console.log('  GET  /api/v1/access-levels                all access levels');
  console.log('  GET  /api/v1/card-types                   all card types');
  console.log('');
  console.log('  GET  /api/v1/admin/keys                   list API keys');
  console.log('  POST /api/v1/admin/keys                   create API key');
  console.log('  DELETE /api/v1/admin/keys/:id             revoke API key');
  console.log('');
});

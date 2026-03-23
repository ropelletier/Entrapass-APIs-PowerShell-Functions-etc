#!/usr/bin/env node
/**
 * manage-keys.js — CLI for API key management
 *
 * Usage:
 *   node manage-keys.js create <name> [days]   Create a new key
 *   node manage-keys.js list                   List all keys
 *   node manage-keys.js revoke <id>            Revoke a key by ID
 *
 * Examples:
 *   node manage-keys.js create "Dashboard"      (no expiry)
 *   node manage-keys.js create "Temp App" 90    (expires in 90 days)
 *   node manage-keys.js list
 *   node manage-keys.js revoke abc123-...
 */

'use strict';

const { createKey, listKeys, revokeKey } = require('./keys');

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'create': {
    const name = args[0];
    const days = args[1] ? parseInt(args[1], 10) : null;
    if (!name) {
      console.error('Usage: node manage-keys.js create <name> [days]');
      process.exit(1);
    }
    const result = createKey(name, days);
    console.log('');
    console.log('API Key Created');
    console.log('  ID:      ', result.id);
    console.log('  Name:    ', result.name);
    console.log('  Key:     ', result.key);
    console.log('  Created: ', result.createdAt);
    console.log('  Expires: ', result.expiresAt || 'never');
    console.log('');
    console.log('  ** Save this key — it will NOT be shown again **');
    console.log('');
    console.log('  Use it in requests:');
    console.log(`    curl -H "X-Api-Key: ${result.key}" http://localhost:3000/api/v1/users`);
    console.log('');
    break;
  }

  case 'list': {
    const keys = listKeys();
    if (!keys.length) {
      console.log('No API keys found.');
      break;
    }
    console.log('');
    console.log('API Keys:');
    console.log('');
    const now = new Date();
    for (const k of keys) {
      let status = 'active';
      if (!k.active) status = 'REVOKED';
      else if (k.expiresAt && new Date(k.expiresAt) <= now) status = 'EXPIRED';

      const expires = k.expiresAt ? k.expiresAt.slice(0, 10) : 'never';
      console.log(`  ${k.id}  ${String(k.name).padEnd(24)}  ${status.padEnd(8)}  expires: ${expires}`);
    }
    console.log('');
    break;
  }

  case 'revoke': {
    const id = args[0];
    if (!id) {
      console.error('Usage: node manage-keys.js revoke <id>');
      process.exit(1);
    }
    const ok = revokeKey(id);
    if (ok) {
      console.log(`Revoked key: ${id}`);
    } else {
      console.error(`Key not found: ${id}`);
      process.exit(1);
    }
    break;
  }

  default:
    console.log('');
    console.log('Usage:');
    console.log('  node manage-keys.js create <name> [days]   Create a key (days = expiry, optional)');
    console.log('  node manage-keys.js list                   List all keys and their status');
    console.log('  node manage-keys.js revoke <id>            Revoke a key by its ID');
    console.log('');
    break;
}

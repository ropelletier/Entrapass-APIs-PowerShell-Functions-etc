/**
 * routes/doors.js — Door control
 *
 * Only returns doors that SmartService can actually control. Doors that
 * exist in the ADS database but are not recognized by SmartService (e.g.
 * disconnected controllers) are excluded from all endpoints.
 *
 * The valid door set is discovered at startup by probing SmartService and
 * refreshed every 10 minutes in the background.
 *
 * GET  /api/v1/doors                  list all controllable doors
 * GET  /api/v1/doors/:id              single door
 * POST /api/v1/doors/:id/unlock       momentary unlock for N seconds (default 5)
 * POST /api/v1/doors/:id/lock         lock (secured) until /normal
 * POST /api/v1/doors/:id/normal       restore to schedule
 * POST /api/v1/doors/:id/arm          arm door alarm
 * POST /api/v1/doors/:id/disarm       disarm door alarm
 * POST /api/v1/doors/:id/one-time-access  grant single access
 */

'use strict';

const router = require('express').Router();
const { query, esc } = require('../db');
const ss = require('../smartservice');

const MODE_LABEL = { 0: 'normal', 1: 'locked', 2: 'unlocked' };

// ---------------------------------------------------------------------------
// Valid door cache — only doors SmartService recognizes
// ---------------------------------------------------------------------------
let validDoorIds = null;               // Set of integer IDs, or null if not yet loaded
let validDoorsLoading = null;          // Promise while refresh is in progress
const REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes

/**
 * Probe SmartService to discover which ADS doors it can actually control.
 * Uses the lightweight DoorBackToSchedule with a known-bad id pattern to
 * check for COMPONENT_NOT_EXIST vs OK/other errors.
 */
async function refreshValidDoors() {
  try {
    const rows = await query('SELECT PkData AS id FROM Door');
    const key = await ss.getSessionKey();
    const valid = new Set();

    // Probe each door — SmartService returns 200 with StandardFault for unknown doors
    const probes = rows.map(async (row) => {
      const id = parseInt(row.id, 10);
      try {
        const res = await ss.ssCall('GET', `Doors/${id}`, { query: {} });
        // If body contains COMPONENT_NOT_EXIST, the door isn't in SmartService
        if (res.body && res.body.includes('COMPONENT_NOT_EXIST')) return;
        // If we get a fault for other reasons, still exclude
        if (res.body && res.body.includes('StandardFault')) return;
        valid.add(id);
      } catch (_) {
        // Network error etc — assume valid to avoid hiding doors during transient failures
        valid.add(id);
      }
    });

    await Promise.all(probes);
    validDoorIds = valid;
    console.log(`[doors] Refreshed valid doors: ${valid.size}/${rows.length} controllable`);
  } catch (err) {
    console.error(`[doors] Failed to refresh valid doors: ${err.message}`);
    // Keep existing cache on failure
  }
}

/**
 * Ensure valid doors are loaded. Returns immediately if cached.
 */
async function ensureValidDoors() {
  if (validDoorIds) return;
  if (!validDoorsLoading) {
    validDoorsLoading = refreshValidDoors().finally(() => { validDoorsLoading = null; });
  }
  await validDoorsLoading;
}

// Refresh on a timer
setInterval(() => refreshValidDoors().catch(() => {}), REFRESH_INTERVAL);
// Initial load (deferred to not block startup)
setTimeout(() => refreshValidDoors().catch(() => {}), 5000);

function isDoorValid(id) {
  // If cache not ready yet, allow all (fail-open)
  if (!validDoorIds) return true;
  return validDoorIds.has(id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDoor(r) {
  const modeCode = parseInt(r.mode, 10);
  return {
    id:       parseInt(r.id, 10),
    name:     r.name,
    mode:     MODE_LABEL[modeCode] || String(modeCode),
    modeCode,
  };
}

async function ssDoorCommand(endpoint, doorId, extraParams = {}) {
  const params = { id: String(doorId), ...extraParams };
  const res = await ss.ssCall('PUT', endpoint, { query: params, body: '', contentType: 'application/xml' });
  if (res.status !== 200) {
    throw new Error(`SmartService ${endpoint} returned ${res.status}: ${res.body}`);
  }

  // Check for StandardFault XML (SmartService returns 200 even on faults)
  const faultMatch = res.body.match(/<FirstLanguageErrorDescription>([^<]*)<\/FirstLanguageErrorDescription>/);
  if (faultMatch) {
    const msgMatch = res.body.match(/<Message>([^<]*)<\/Message>/);
    const msg = msgMatch ? msgMatch[1].replace(/&#xD;\n/g, ' ') : faultMatch[1];
    throw new Error(`SmartService ${endpoint}: ${msg}`);
  }

  // Response is <ServiceCommandResult>OK</ServiceCommandResult> or error text
  const match = res.body.match(/<ServiceCommandResult>([^<]*)<\/ServiceCommandResult>/);
  const result = match ? match[1] : res.body;
  if (result !== 'OK') {
    throw new Error(`SmartService ${endpoint}: ${result}`);
  }
  return result;
}

/**
 * Lookup a door by ID, checking it exists in both ADS and SmartService.
 * Returns the row or sends an error response and returns null.
 */
async function lookupDoor(id, res) {
  if (isNaN(id)) { res.status(400).json({ error: 'id must be a number' }); return null; }

  await ensureValidDoors();
  if (!isDoorValid(id)) {
    res.status(404).json({ error: 'Door not found or not controllable via SmartService' });
    return null;
  }

  const rows = await query(
    `SELECT PkData AS id, Description1 AS name, OperationMode AS mode FROM Door WHERE PkData = ${id}`
  );
  if (!rows.length) { res.status(404).json({ error: 'Door not found' }); return null; }
  return rows[0];
}

// ---------------------------------------------------------------------------
// GET /api/v1/doors
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    await ensureValidDoors();
    const rows = await query(
      'SELECT PkData AS id, Description1 AS name, OperationMode AS mode FROM Door ORDER BY Description1'
    );
    const doors = rows
      .filter(r => isDoorValid(parseInt(r.id, 10)))
      .map(formatDoor);
    res.json({ count: doors.length, doors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/doors/:id
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const row = await lookupDoor(parseInt(req.params.id, 10), res);
    if (!row) return;
    res.json(formatDoor(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/doors/:id/config
//
// Full door configuration — wiring assignments (contacts, REX, relays),
// unlock timing, lock mode, and behaviour flags. Sourced from SmartService
// `GET Doors/{id}?shortReturn=0` and translated to a stable JSON shape.
//
// Intended for hardware diagnostics — comparing sibling doors to isolate
// wiring issues, spotting missing contact / relay assignments, and checking
// unlock/relock timing without opening the workstation GUI.
// ---------------------------------------------------------------------------
router.get('/:id/config', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

    // Basic row for name / current mode
    const doorRow = await lookupDoor(id, res);
    if (!doorRow) return;

    // Pull the full XML from SmartService
    const ssRes = await ss.ssCall('GET', `Doors/${id}`, { query: { shortReturn: '0' } });
    if (ssRes.status !== 200) {
      return res.status(500).json({ error: `SmartService GET Doors/${id} returned ${ssRes.status}` });
    }
    const xml = ssRes.body;

    // Helpers
    const strOf = (tag) => {
      const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return m ? m[1] : null;
    };
    const intOf = (tag) => { const v = strOf(tag); return v === null ? null : parseInt(v, 10); };
    const boolOf = (tag) => { const v = strOf(tag); return v === null ? null : (v === 'True'); };

    // Resolve any FK values that point at hardware components. Prefer ADS
    // lookups (fast, local, no SmartService cost).
    const fks = {
      rexContact:            intOf('FKREXContact')            || 0,
      secondaryRexContact:   intOf('FKSecondaryREXContact')   || 0,
      doorContact:           intOf('FKDataDoorContact')       || 0,
      interlockContact:      intOf('FKInterlockContact')      || 0,
      lockingRelay:          intOf('FkRelayLockingDevice')    || 0,
      accessGrantedRelay:    intOf('FKRelayAccessGranted')    || 0,
      accessDeniedRelay:     intOf('FKRelayAccessDenied')     || 0,
      doorForcedRelay:       intOf('FKRelayDoorForced')       || 0,
      doorOpenTooLongRelay:  intOf('FKRelayDoorOpenTooLong')  || 0,
      alarmRelay:            intOf('FKAlarmRelay')            || 0,
    };

    const nameOf = async (table, id) => {
      if (!id) return null;
      const rows = await query(`SELECT Description1 FROM ${table} WHERE PkData = ${esc(id)}`);
      return rows.length ? rows[0].Description1 : null;
    };

    const [rexContactName, secondaryRexContactName, doorContactName, interlockContactName,
           lockingRelayName, accessGrantedRelayName, accessDeniedRelayName,
           doorForcedRelayName, doorOpenTooLongRelayName, alarmRelayName] = await Promise.all([
      nameOf('Input',  fks.rexContact),
      nameOf('Input',  fks.secondaryRexContact),
      nameOf('Input',  fks.doorContact),
      nameOf('Input',  fks.interlockContact),
      nameOf('Relay',  fks.lockingRelay),
      nameOf('Relay',  fks.accessGrantedRelay),
      nameOf('Relay',  fks.accessDeniedRelay),
      nameOf('Relay',  fks.doorForcedRelay),
      nameOf('Relay',  fks.doorOpenTooLongRelay),
      nameOf('Relay',  fks.alarmRelay),
    ]);

    const scheduleName = async (id) => {
      if (!id) return null;
      const rows = await query(`SELECT Description1 FROM Schedule WHERE PkData = ${esc(id)}`);
      return rows.length ? rows[0].Description1 : null;
    };

    const rexScheduleId       = intOf('FKREXSchedule')          || 0;
    const unlockScheduleId    = intOf('FKUnlockSchedule')       || 0;
    const doorContactSchedId  = intOf('FKDoorContactSchedule')  || 0;

    const [rexScheduleN, unlockScheduleN, doorContactSchedN] = await Promise.all([
      scheduleName(rexScheduleId),
      scheduleName(unlockScheduleId),
      scheduleName(doorContactSchedId),
    ]);

    res.json({
      id,
      name:            doorRow.name,
      mode:            MODE_LABEL[parseInt(doorRow.mode, 10)] || String(doorRow.mode),
      hardware: {
        ktType:      strOf('KTType'),
        doorLockMode: strOf('DoorLockMode'),
      },
      timing: {
        unlockTimeSec:            intOf('UnlockTime'),
        openTimeSec:              intOf('OpenTime'),
        extendedUnlockTimeSec:    intOf('ExtendedUnlockTime'),
        extendedOpenTimeSec:      intOf('ExtendedOpenTime'),
        extendedDelayBeforeLock:  intOf('ExtendedDelayBeforeLock'),
        unlockGracePeriodSec:     intOf('UnlockGracePeriod'),
      },
      contacts: {
        doorContact:         { id: fks.doorContact,         name: doorContactName,           schedule: { id: doorContactSchedId, name: doorContactSchedN } },
        rexContact:          { id: fks.rexContact,          name: rexContactName,            schedule: { id: rexScheduleId,      name: rexScheduleN      } },
        secondaryRexContact: { id: fks.secondaryRexContact, name: secondaryRexContactName },
        interlockContact:    { id: fks.interlockContact,    name: interlockContactName },
      },
      relays: {
        lockingDevice:      { id: fks.lockingRelay,         name: lockingRelayName },
        accessGranted:      { id: fks.accessGrantedRelay,   name: accessGrantedRelayName },
        accessDenied:       { id: fks.accessDeniedRelay,    name: accessDeniedRelayName },
        doorForced:         { id: fks.doorForcedRelay,      name: doorForcedRelayName },
        doorOpenTooLong:    { id: fks.doorOpenTooLongRelay, name: doorOpenTooLongRelayName },
        alarm:              { id: fks.alarmRelay,           name: alarmRelayName },
      },
      behaviour: {
        onAccess:                boolOf('OnAccess'),
        onRex:                   boolOf('OnREX'),
        unlockOnRex:             boolOf('UnlockOnREX'),
        secondaryUnlockOnRex:    boolOf('SecondaryUnlockOnREX'),
        rexRestartPrimary:       boolOf('REXRestartPrimary'),
        rexRestartSecondary:     boolOf('REXRestartSecondary'),
        unlockOnAccessDoorOpened: boolOf('UnlockOnAccessDoorOpened'),
        unlockScheduleAccessGranted: boolOf('UnlockScheduleAccessGranted'),
        unlockDeviceNotSupervised: boolOf('UnlockDeviceNotSupervised'),
        doorOpenReading:         boolOf('DoorOpenReading'),
        doorUnlockReading:       boolOf('DoorUnlockReading'),
      },
      alarms: {
        alarmOnDOTL:              boolOf('AlarmOnDOTL'),
        alarmOnDOTLDelaySec:      intOf('AlarmOnDOTLDelay'),
      },
      schedules: {
        rex:                     { id: rexScheduleId,     name: rexScheduleN },
        unlock:                  { id: unlockScheduleId,  name: unlockScheduleN },
        doorContact:             { id: doorContactSchedId, name: doorContactSchedN },
      },
    });
  } catch (err) {
    console.error('GET /doors/:id/config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/doors/:id/unlock — momentary unlock for N seconds
// ---------------------------------------------------------------------------
async function handleUnlock(req, res) {
  try {
    const id      = parseInt(req.params.id, 10);
    const seconds = Math.max(1, Math.min(3600, parseInt((req.body && req.body.seconds) || req.query.seconds || 5, 10)));
    const row = await lookupDoor(id, res);
    if (!row) return;

    await ssDoorCommand('TemporarilyUnlockDoor', id, { delay: String(seconds) });

    res.json({
      ok:       true,
      doorId:   id,
      doorName: row.name,
      action:   'unlock',
      seconds,
      revertsAt: new Date(Date.now() + seconds * 1000).toISOString(),
    });
  } catch (err) {
    console.error('POST /doors/unlock error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
router.get('/:id/unlock',  handleUnlock);
router.post('/:id/unlock', handleUnlock);

// ---------------------------------------------------------------------------
// POST /api/v1/doors/:id/lock — lock door (secured) until /normal
// ---------------------------------------------------------------------------
async function handleLock(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await lookupDoor(id, res);
    if (!row) return;

    await ssDoorCommand('LockDoor', id);

    res.json({ ok: true, doorId: id, doorName: row.name, action: 'lock', mode: 'locked' });
  } catch (err) {
    console.error('POST /doors/lock error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
router.get('/:id/lock',  handleLock);
router.post('/:id/lock', handleLock);

// ---------------------------------------------------------------------------
// POST /api/v1/doors/:id/normal — restore door to schedule
// ---------------------------------------------------------------------------
async function handleNormal(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await lookupDoor(id, res);
    if (!row) return;

    await ssDoorCommand('DoorBackToSchedule', id);

    res.json({ ok: true, doorId: id, doorName: row.name, action: 'normal', mode: 'normal' });
  } catch (err) {
    console.error('POST /doors/normal error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
router.get('/:id/normal',  handleNormal);
router.post('/:id/normal', handleNormal);

// ---------------------------------------------------------------------------
// POST /api/v1/doors/:id/arm — arm door alarm
// ---------------------------------------------------------------------------
router.post('/:id/arm', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await lookupDoor(id, res);
    if (!row) return;

    await ssDoorCommand('ArmDoor', id, { forceSend: '0' });

    res.json({ ok: true, doorId: id, doorName: row.name, action: 'arm' });
  } catch (err) {
    console.error('POST /doors/arm error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/doors/:id/disarm — disarm door alarm
// ---------------------------------------------------------------------------
router.post('/:id/disarm', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await lookupDoor(id, res);
    if (!row) return;

    await ssDoorCommand('DisarmDoor', id, { forceSend: '0' });

    res.json({ ok: true, doorId: id, doorName: row.name, action: 'disarm' });
  } catch (err) {
    console.error('POST /doors/disarm error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/doors/:id/one-time-access — grant single access
// ---------------------------------------------------------------------------
router.post('/:id/one-time-access', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await lookupDoor(id, res);
    if (!row) return;

    await ssDoorCommand('OneTimeAccess', id);

    res.json({ ok: true, doorId: id, doorName: row.name, action: 'one-time-access' });
  } catch (err) {
    console.error('POST /doors/one-time-access error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

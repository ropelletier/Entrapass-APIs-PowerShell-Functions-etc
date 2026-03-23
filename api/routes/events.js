/**
 * routes/events.js — Door event endpoints (reads from ADS archive directly)
 *
 * GET /api/v1/events                  today's events
 * GET /api/v1/events?date=2026-03-22  events for a specific date
 * GET /api/v1/events?user_id=123      filter by cardholder ID (any date)
 * GET /api/v1/events?door=CES         filter by door name (LIKE, today only)
 * GET /api/v1/events?granted=true     only access-granted events (today)
 * GET /api/v1/users/:id/events        all today's events for one cardholder
 *
 * NOTE: Each day's events are in a separate ADS archive table named YYYY-MM-DD.
 *       Cross-day queries run one asqlcmd call per date in the requested range.
 *       Large date ranges may be slow — use ?date= to target a specific day.
 */

'use strict';

const router = require('express').Router();
const { query, esc, escStr, ARCH_CONN } = require('../db');

// Event type IDs that represent an access-granted result
const GRANTED_IDS = new Set([202, 203, 225, 908, 913, 914, 934]);

function formatDate(d) {
  return d.toISOString().slice(0, 10);  // YYYY-MM-DD
}

/**
 * Query one day's archive.
 * Table name = date string (must be bracket-quoted because it starts with a digit).
 */
async function queryDay(dateStr, extraWhere) {
  const where = extraWhere ? `AND (${extraWhere})` : '';
  const sql = `
    SELECT
      e.PkSequence          AS Seq,
      e.DateTime            AS EventDateTime,
      e.ServerDateTime      AS ServerDateTime,
      e.FkObjectMessage     AS EventTypeID,
      e.Cluster             AS Cluster,
      e.Site                AS Site,
      e.Data1Object         AS Data1Object,
      e.FkData1             AS DoorID,
      e.Data2Object         AS Data2Object,
      e.FkData2             AS CardholderID
    FROM [${dateStr}] e
    WHERE 1=1 ${where}
    ORDER BY e.PkSequence ASC
  `;
  try {
    return await query(sql, ARCH_CONN);
  } catch {
    return [];  // archive file for that day doesn't exist
  }
}

/** Resolve door and cardholder names for a batch of raw event rows */
async function enrichEvents(rawRows, db) {
  if (!rawRows.length) return [];

  const doorIds = [...new Set(
    rawRows.filter(r => r.Data1Object === '12' && parseInt(r.DoorID) > 0)
           .map(r => r.DoorID)
  )];
  const cardIds = [...new Set(
    rawRows.filter(r => r.Data2Object === '5' && parseInt(r.CardholderID) > 0)
           .map(r => r.CardholderID)
  )];

  const doorMap = {};
  const cardMap = {};

  if (doorIds.length) {
    const rows = await db.query(
      `SELECT PkData, Description1 FROM Door WHERE PkData IN (${doorIds.join(',')})`,
      db.DATA_CONN
    );
    for (const r of rows) doorMap[r.PkData] = r.Description1;
  }

  if (cardIds.length) {
    const rows = await db.query(
      `SELECT PkData, UserName, CardNumberFormatted FROM Card WHERE PkData IN (${cardIds.join(',')})`,
      db.DATA_CONN
    );
    for (const r of rows) cardMap[r.PkData] = { name: r.UserName, card: r.CardNumberFormatted };
  }

  return rawRows.map(r => {
    const typeId = parseInt(r.EventTypeID, 10);
    const doorId = r.Data1Object === '12' ? r.DoorID : null;
    const chId   = r.Data2Object === '5'  ? r.CardholderID : null;

    return {
      seq:             r.Seq,
      eventDateTime:   r.EventDateTime,
      serverDateTime:  r.ServerDateTime,
      eventTypeID:     typeId,
      cluster:         r.Cluster,
      site:            r.Site,
      doorID:          doorId || null,
      doorName:        doorId ? (doorMap[doorId] || `Door ${doorId}`) : null,
      cardholderID:    chId   || null,
      cardholderName:  chId   ? (cardMap[chId]?.name || '') : null,
      cardNumber:      chId   ? (cardMap[chId]?.card || '') : null,
      accessGranted:   GRANTED_IDS.has(typeId),
    };
  });
}

// ---------------------------------------------------------------------------
// GET /api/v1/events
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const db = require('../db');
    const dateParam   = req.query.date;
    const userIdParam = req.query.user_id;
    const doorParam   = req.query.door;
    const grantedOnly = req.query.granted === 'true';

    const dateStr = dateParam
      ? dateParam.replace(/[^0-9-]/g, '')          // sanitise
      : formatDate(new Date());

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }

    let extra = '';
    if (userIdParam) extra = `e.Data2Object = '5' AND e.FkData2 = ${esc(parseInt(userIdParam, 10))}`;

    const rawRows = await queryDay(dateStr, extra);
    let events    = await enrichEvents(rawRows, db);

    if (doorParam) {
      const lc = doorParam.toLowerCase();
      events = events.filter(e => e.doorName?.toLowerCase().includes(lc));
    }
    if (grantedOnly) {
      events = events.filter(e => e.accessGranted);
    }

    res.json({ date: dateStr, count: events.length, events });
  } catch (err) {
    console.error('/events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/events/recent?minutes=60
// Returns events from the last N minutes (default 60). Handles midnight rollover.
// ---------------------------------------------------------------------------
router.get('/recent', async (req, res) => {
  try {
    const db      = require('../db');
    const minutes = Math.max(1, Math.min(1440, parseInt(req.query.minutes, 10) || 60));
    const now     = new Date();
    const cutoff  = new Date(now.getTime() - minutes * 60 * 1000);

    const todayStr     = formatDate(now);
    const cutoffStr    = formatDate(cutoff);
    const sameDay      = todayStr === cutoffStr;

    let rawRows = await queryDay(todayStr, '');

    // If the window spans midnight, also fetch yesterday's archive
    if (!sameDay) {
      const yestRows = await queryDay(cutoffStr, '');
      rawRows = yestRows.concat(rawRows);
    }

    let events = await enrichEvents(rawRows, db);

    // Filter to only events within the window
    events = events.filter(e => {
      if (!e.eventDateTime) return false;
      const t = new Date(e.eventDateTime);
      return !isNaN(t) && t >= cutoff && t <= now;
    });

    res.json({ since: cutoff.toISOString(), minutes, count: events.length, events });
  } catch (err) {
    console.error('/events/recent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.queryDay    = queryDay;
module.exports.enrichEvents = enrichEvents;

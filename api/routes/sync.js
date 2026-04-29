/**
 * routes/sync.js — Sync endpoints for STO integration
 *
 * GET /api/v1/sync/cursor     — max TransactionTag per entity type
 * GET /api/v1/sync/changes    — records changed since a given cursor
 *
 * These endpoints support STO's delta polling loop. They use ADS reads only
 * (no SmartService sessions consumed).
 */

'use strict';

const router = require('express').Router();
const { query, esc, escStr } = require('../db');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse an ADS TransactionTag string (MM/DD/YYYY HH:MM:SS AM/PM) to a JS Date.
 */
function parseTag(tag) {
  if (!tag) return null;
  return new Date(tag);
}

/**
 * Convert a JS Date to ISO 8601 string.
 */
function tagToISO(tag) {
  const d = parseTag(tag);
  return d && !isNaN(d.getTime()) ? d.toISOString() : null;
}

/**
 * Convert an ISO 8601 string to an ADS timestamp literal for WHERE clauses.
 * Input:  "2026-04-28T15:00:00.000Z"
 * Output: "{ts '2026-04-28 15:00:00'}"
 */
function isoToAdsLiteral(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const str = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
              `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `{ts '${str}'}`;
}

/**
 * Get max TransactionTag from a table, returned as ISO string.
 */
async function getMaxTag(table) {
  const rows = await query(`SELECT MAX(TransactionTag) AS maxTag FROM ${table}`);
  return tagToISO((rows[0] && rows[0].maxTag) || null);
}

// ---------------------------------------------------------------------------
// GET /api/v1/sync/cursor
//
// Returns the latest TransactionTag (as ISO 8601) for each entity type.
// STO compares these to its last known values — if unchanged, skip the fetch.
// ---------------------------------------------------------------------------
router.get('/cursor', async (req, res) => {
  try {
    const [cardMax, alMax, ctMax] = await Promise.all([
      getMaxTag('Card'),
      getMaxTag('AccessLevel'),
      getMaxTag('CardType'),
    ]);

    res.json({
      cardholders:  cardMax,
      accessLevels: alMax,
      cardTypes:    ctMax,
    });
  } catch (err) {
    console.error('/sync/cursor error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/sync/changes?since={iso}
//
// Returns all records changed since the given cursor, across all entity types.
// Full records (not just IDs) so STO can update its cache without follow-up GETs.
//
// Response includes a `cursor` field for the next poll.
//
// Deletion detection: records that existed before `since` but are now gone
// cannot be detected by TransactionTag alone (deleted rows have no tag).
// STO should use the full snapshot loop (5min) as a safety net for deletions.
// ---------------------------------------------------------------------------
router.get('/changes', async (req, res) => {
  try {
    const since = req.query.since;
    if (!since) return res.status(400).json({ error: 'since parameter is required (ISO 8601)' });

    const adsLiteral = isoToAdsLiteral(since);
    if (!adsLiteral) return res.status(400).json({ error: 'Invalid since timestamp. Use ISO 8601 format.' });

    // Fetch changed records in parallel
    const [cardholders, accessLevels, cardTypes, newCursor] = await Promise.all([
      getChangedCardholders(adsLiteral),
      getChangedAccessLevels(adsLiteral),
      getChangedCardTypes(adsLiteral),
      getMaxTag('Card').then(async cardMax => {
        const alMax = await getMaxTag('AccessLevel');
        const ctMax = await getMaxTag('CardType');
        // cursor = the latest tag across all entity types
        return [cardMax, alMax, ctMax].filter(Boolean).sort().pop() || since;
      }),
    ]);

    // For changed cardholders, also fetch their cards and exceptions
    const cardholderIds = cardholders.map(c => parseInt(c.id, 10));
    let cards = [];
    let accessExceptions = [];

    if (cardholderIds.length) {
      const idList = cardholderIds.join(',');
      cards = await getCardsForUsers(idList);
      accessExceptions = await getExceptionsForUsers(idList);
    }

    res.json({
      since,
      cursor: newCursor,
      changes: {
        cardholders,
        cards,
        accessLevels,
        cardTypes,
        accessExceptions,
      },
    });
  } catch (err) {
    console.error('/sync/changes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

async function getChangedCardholders(adsLiteral) {
  const rows = await query(`
    SELECT c.PkData AS id, c.UserName AS name, c.State AS state, c.Email AS email,
      c.CreationDate AS createdAt, c.CardNumberCount AS cardCount,
      c.CardInfo1, c.CardInfo2, c.CardInfo3, c.CardInfo4, c.CardInfo5, c.CardInfo20 AS UUID,
      c.FkCardType AS cardTypeId, ct.Description1 AS cardTypeName,
      ic.FkICDataAccessLevel AS accessLevelId, al.Description1 AS accessLevelName,
      c.TransactionTag
    FROM Card c
    LEFT JOIN ItemCard ic ON c.PkData = ic.FkDataCard AND ic.ObjectCard = 38
    LEFT JOIN AccessLevel al ON ic.FkICDataAccessLevel = al.PkData
    LEFT JOIN CardType ct ON c.FkCardType = ct.PkData
    WHERE c.TransactionTag > ${adsLiteral}
    ORDER BY c.TransactionTag DESC
  `);

  const STATE_LABELS = { '1': 'Active', '2': 'Inactive', '0': 'Lost/Stolen' };

  return rows.map(r => ({
    id:              r.id,
    name:            r.name,
    state:           r.state,
    stateLabel:      STATE_LABELS[r.state] || r.state,
    email:           r.email || '',
    createdAt:       r.createdAt || null,
    cardCount:       parseInt(r.cardCount, 10) || 0,
    cardTypeId:      r.cardTypeId ? parseInt(r.cardTypeId, 10) : null,
    cardTypeName:    r.cardTypeName || null,
    accessLevelId:   r.accessLevelId ? parseInt(r.accessLevelId, 10) : null,
    accessLevelName: r.accessLevelName || null,
    cardInfo1:       r.CardInfo1 || '',
    cardInfo2:       r.CardInfo2 || '',
    cardInfo3:       r.CardInfo3 || '',
    cardInfo4:       r.CardInfo4 || '',
    cardInfo5:       r.CardInfo5 || '',
    uuid:            r.UUID || '',
    changedAt:       tagToISO(r.TransactionTag),
    deleted:         false,
  }));
}

async function getCardsForUsers(idList) {
  const rows = await query(`
    SELECT n.PkCard AS cardholderID, n.CardNumberFormatted AS number,
      n.CardNumber AS numberRaw, n.LostStolen, n.Deactivated,
      n.Trace, n.UseEndDate AS hasExpiry, n.EndDate AS endDate, n.CardPosition AS slot
    FROM CardNumber n
    WHERE n.PkCard IN (${idList})
    ORDER BY n.PkCard, n.CardPosition
  `);

  return rows.map(r => ({
    cardholderID: r.cardholderID,
    number:       r.number,
    numberRaw:    r.numberRaw || '',
    lostStolen:   r.LostStolen === '1' || r.LostStolen === 'True',
    deactivated:  r.Deactivated === '1' || r.Deactivated === 'True',
    trace:        r.Trace === '1' || r.Trace === 'True',
    hasExpiry:    r.hasExpiry === '1' || r.hasExpiry === 'True',
    endDate:      r.endDate || null,
    slot:         parseInt(r.slot, 10),
  }));
}

async function getExceptionsForUsers(idList) {
  const rows = await query(`
    SELECT ic.FkDataCard AS cardholderID, ic.FkDataGSI AS componentId,
      ic.FkICDataSchedule AS scheduleId, s.Description1 AS scheduleName,
      ic.DoorExceptionMode AS doorExceptionMode
    FROM ItemCard ic
    LEFT JOIN Schedule s ON ic.FkICDataSchedule = s.PkData
    WHERE ic.FkDataCard IN (${idList}) AND ic.ObjectCard = 12
    ORDER BY ic.FkDataCard, ic.FkDataGSI
  `);

  return rows.map(r => ({
    cardholderID:      r.cardholderID,
    componentId:       parseInt(r.componentId, 10),
    scheduleId:        parseInt(r.scheduleId || '0', 10),
    scheduleName:      r.scheduleName || '',
    doorExceptionMode: parseInt(r.doorExceptionMode || '0', 10),
  }));
}

async function getChangedAccessLevels(adsLiteral) {
  const rows = await query(`
    SELECT PkData AS id, Description1 AS name, Description2 AS description,
      AllValid AS allValid, NoneValid AS noneValid, State, TransactionTag
    FROM AccessLevel
    WHERE TransactionTag > ${adsLiteral}
    ORDER BY TransactionTag DESC
  `);

  return rows.map(r => ({
    id:          r.id,
    name:        r.name,
    description: r.description || '',
    allValid:    r.allValid === '1' || r.allValid === 'True',
    noneValid:   r.noneValid === '1' || r.noneValid === 'True',
    active:      r.State === '1',
    changedAt:   tagToISO(r.TransactionTag),
    deleted:     false,
  }));
}

async function getChangedCardTypes(adsLiteral) {
  const rows = await query(`
    SELECT PkData AS id, Description1 AS name, Description2 AS description,
      State, TransactionTag
    FROM CardType
    WHERE TransactionTag > ${adsLiteral}
    ORDER BY TransactionTag DESC
  `);

  return rows.map(r => ({
    id:          r.id,
    name:        r.name,
    description: r.description || '',
    active:      r.State === '1',
    changedAt:   tagToISO(r.TransactionTag),
    deleted:     false,
  }));
}

module.exports = router;

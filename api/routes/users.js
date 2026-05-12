/**
 * routes/users.js — Cardholder endpoints
 *
 * GET  /api/v1/users                      all users (grouped by cardholder)
 * GET  /api/v1/users?name=Smith           LIKE search on FullName
 * GET  /api/v1/users?card=00001234        search by card number
 * GET  /api/v1/users?state=0              filter by state (0=Active 1=Lost 2=Inactive)
 * GET  /api/v1/users?access_level=Staff   filter by access level (LIKE)
 * GET  /api/v1/users/:id                  single user by CardholderID
 * GET  /api/v1/users/:id/cards            all cards assigned to a user
 * POST /api/v1/users                      create new cardholder (via SmartService)
 * PUT  /api/v1/users/:id                  update cardholder fields (name via ADS, rest via SmartService)
 */

'use strict';

const router = require('express').Router();
const { query, execute, esc, escStr } = require('../db');
const { queryDay, enrichEvents } = require('./events');
const { mapOutbound } = require('../field-map');
const ss = require('../smartservice');

// ---------------------------------------------------------------------------
// Base SELECT — joins Card → CardNumber → ItemCard → AccessLevel
// Returns one row per card (cardholders with no card get one row with nulls).
// ---------------------------------------------------------------------------
const BASE_SQL = `
SELECT
  c.PkData                AS CardholderID,
  c.UserName              AS FullName,
  c.State                 AS State,
  c.Email                 AS Email,
  c.CreationDate          AS CreationDate,
  c.ExternalUserID        AS ExternalUserID,
  c.Info1                 AS Info1,
  c.Info2                 AS Info2,
  c.Info3                 AS Info3,
  c.Info4                 AS Info4,
  c.CardInfo1             AS CardInfo1,
  c.CardInfo2             AS CardInfo2,
  c.CardInfo3             AS CardInfo3,
  c.CardInfo4             AS CardInfo4,
  c.CardInfo5             AS CardInfo5,
  c.CardInfo3             AS Key1,
  c.CardInfo8             AS Key2,
  c.CardInfo4             AS Key3,
  c.CardInfo9             AS Key4,
  c.CardInfo5             AS Key5,
  c.CardInfo10            AS Key6,
  c.CardInfo20            AS UUID,
  c.CardNumberCount       AS CardCount,
  c.FkCardType            AS CardTypeId,
  ct.Description1         AS CardTypeName,
  n.CardNumberFormatted   AS CardNumber,
  n.CardNumber            AS CardNumberRaw,
  n.LostStolen            AS CardLostStolen,
  n.Deactivated           AS CardDeactivated,
  n.UseEndDate            AS CardHasExpiry,
  n.EndDate               AS CardEndDate,
  ic.FkICDataAccessLevel  AS AccessLevelId,
  al.Description1         AS AccessLevel
FROM Card c
LEFT OUTER JOIN CardNumber  n  ON c.PkData = n.PkCard
LEFT OUTER JOIN ItemCard    ic ON c.PkData = ic.FkDataCard AND ic.ObjectCard = 38
LEFT OUTER JOIN AccessLevel al ON ic.FkICDataAccessLevel = al.PkData
LEFT OUTER JOIN CardType    ct ON c.FkCardType = ct.PkData
`;

const STATE_LABELS = { '1': 'Active', '2': 'Inactive', '0': 'Lost/Stolen' };

// ---------------------------------------------------------------------------
// Helper: group flat card rows into user objects with a cards[] array
// ---------------------------------------------------------------------------
function groupUsers(rows) {
  const map = new Map();

  for (const r of rows) {
    const id = r.CardholderID;
    if (!map.has(id)) {
      map.set(id, {
        id:          id,
        name:        r.FullName,
        state:       r.State,
        stateLabel:  STATE_LABELS[r.State] || r.State,
        email:       r.Email        || '',
        createdAt:   r.CreationDate || null,
        externalId:  r.ExternalUserID || '',
        info: {
          info1: r.Info1 || '', info2: r.Info2 || '',
          info3: r.Info3 || '', info4: r.Info4 || '',
        },
        cardInfo: mapOutbound({
          cardInfo1: r.CardInfo1 || '', cardInfo2: r.CardInfo2 || '',
          cardInfo3: r.CardInfo3 || '', cardInfo4: r.CardInfo4 || '',
          cardInfo5: r.CardInfo5 || '',
        }),
        cardCount:       parseInt(r.CardCount, 10) || 0,
        uuid:            r.UUID || '',
        key1:            r.Key1 || '',
        key2:            r.Key2 || '',
        key3:            r.Key3 || '',
        key4:            r.Key4 || '',
        key5:            r.Key5 || '',
        key6:            r.Key6 || '',
        keys:            [r.Key1, r.Key2, r.Key3, r.Key4, r.Key5, r.Key6].filter(k => k && k.trim()),
        cardTypeId:      r.CardTypeId ? parseInt(r.CardTypeId, 10) : null,
        cardTypeName:    r.CardTypeName || null,
        accessLevelId:   r.AccessLevelId ? parseInt(r.AccessLevelId, 10) : null,
        accessLevelName: r.AccessLevel || null,
        cards: [],
      });
    }

    if (r.CardNumber) {
      map.get(id).cards.push({
        number:      r.CardNumber,
        numberRaw:   r.CardNumberRaw    || '',
        lostStolen:  r.CardLostStolen   === '1' || r.CardLostStolen === 'True',
        deactivated: r.CardDeactivated  === '1' || r.CardDeactivated === 'True',
        hasExpiry:   r.CardHasExpiry    === '1' || r.CardHasExpiry   === 'True',
        endDate:     r.CardEndDate      || null,
        accessLevel: r.AccessLevel      || '',
      });
    }
  }

  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// GET /api/v1/users
// GET /api/v1/users?name=Smith
// GET /api/v1/users?card=00001234
// GET /api/v1/users?state=0
// GET /api/v1/users?access_level=Staff
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { name, card, state, access_level } = req.query;
    const conditions = [];

    if (name)                conditions.push(`UPPER(c.UserName) LIKE UPPER(${escStr('%' + name + '%')})`);
    if (card)                conditions.push(`(n.CardNumberFormatted = ${escStr(card)} OR n.CardNumber = ${escStr(card)})`);
    if (state !== undefined) conditions.push(`c.State = ${esc(state)}`);
    if (access_level)        conditions.push(`UPPER(al.Description1) LIKE UPPER(${escStr('%' + access_level + '%')})`);

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows  = await query(BASE_SQL + where + ' ORDER BY c.UserName, n.CardNumberFormatted');
    const users = groupUsers(rows);
    res.json({ count: users.length, users });
  } catch (err) {
    console.error('/users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/users/:id
// ---------------------------------------------------------------------------
router.get('/:id/cards', async (req, res) => {
  // Defined before /:id so Express doesn't treat "cards" as an id
  try {
    const id   = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

    const rows  = await query(BASE_SQL + `WHERE c.PkData = ${id} ORDER BY n.CardNumberFormatted`);
    const users = groupUsers(rows);
    if (!users.length) return res.status(404).json({ error: 'User not found' });
    res.json({ cardholderID: id, cards: users[0].cards });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/users/:id/events — today's events for one cardholder
// Optional ?date=YYYY-MM-DD to query a different day
// ---------------------------------------------------------------------------
router.get('/:id/events', async (req, res) => {
  try {
    const db = require('../db');
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

    const dateStr = req.query.date
      ? req.query.date.replace(/[^0-9-]/g, '')
      : new Date().toISOString().slice(0, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }

    const rawRows = await queryDay(dateStr, `e.Data2Object = '5' AND e.FkData2 = ${id}`);
    const events  = await enrichEvents(rawRows, db);
    res.json({ cardholderID: id, date: dateStr, count: events.length, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

    const rows  = await query(BASE_SQL + `WHERE c.PkData = ${id} ORDER BY n.CardNumberFormatted`);
    const users = groupUsers(rows);
    if (!users.length) return res.status(404).json({ error: 'User not found' });
    res.json(users[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/users — create cardholder via SmartService
//
// Required body: { name }
// Optional:      { email, cardType, accessLevel }
//
//   cardType    — card type ID (default 18 = Employee)
//   accessLevel — access level ID or name (case-insensitive)
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { name, email, cardType, accessLevel } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });

    // Auto-assign next available PkData
    const maxRows = await query('SELECT MAX(PkData) AS MaxID FROM Card');
    const newId = (parseInt((maxRows[0] && maxRows[0].MaxID) || '0', 10) || 0) + 1;

    // Resolve access level (by name or ID)
    let accessLevelId = null;
    let accessLevelName = null;
    if (accessLevel !== undefined && accessLevel !== null && accessLevel !== '') {
      if (!isNaN(Number(accessLevel))) {
        accessLevelId = parseInt(accessLevel, 10);
        const alRows = await query(`SELECT Description1 FROM AccessLevel WHERE PkData = ${esc(accessLevelId)}`);
        if (!alRows.length) return res.status(404).json({ error: `Access level ID ${accessLevelId} not found` });
        accessLevelName = alRows[0].Description1;
      } else {
        const alRows = await query(
          `SELECT PkData, Description1 FROM AccessLevel WHERE UPPER(Description1) = UPPER(${escStr(accessLevel)})`
        );
        if (!alRows.length) return res.status(404).json({ error: `Access level not found: ${accessLevel}` });
        accessLevelId = parseInt(alRows[0].PkData, 10);
        accessLevelName = alRows[0].Description1;
      }
    }

    // Validate access level is active (State=1). Legacy levels (State=2) are not recognized by SmartService.
    if (accessLevelId) {
      const stateRows = await query(`SELECT State FROM AccessLevel WHERE PkData = ${esc(accessLevelId)}`);
      if (stateRows.length && stateRows[0].State !== '1') {
        return res.status(400).json({ error: `Access level ${accessLevelId} (${accessLevelName}) is inactive (legacy). Only active access levels can be assigned. Use GET /access-levels and look for "active": true.` });
      }
    }

    // Build Card XML with flat fields + optional access level fragment
    const flatFields = {
      UserName: name,
      CardType: cardType || ss.DEFAULT_CARD_TYPE,
    };
    if (email) flatFields.Email = email;

    const fragments = [];
    if (accessLevelId) {
      fragments.push(ss.buildAccessLevelsFragment(accessLevelId));
    }

    const xml = ss.buildCardXmlFull(newId, flatFields, fragments);
    const resultId = await ss.createCard(newId, xml);

    res.status(201).json({
      ok:              true,
      id:              resultId,
      name,
      email:           email || '',
      cardType:        parseInt(cardType || ss.DEFAULT_CARD_TYPE, 10),
      accessLevelId:   accessLevelId,
      accessLevelName: accessLevelName,
    });
  } catch (err) {
    console.error('POST /users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/users/:id — update cardholder fields
//
// Updatable: name, state, email, cardType, cardInfo1-5
//
// Name and state changes go through ADS (SmartService doesn't support these
// as in-place updates), then a no-op PUT flushes SmartService's cache.
// All other fields go through SmartService PUT Cards/{id} directly.
// ---------------------------------------------------------------------------
router.put('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });

    const body = req.body;
    const { name, state, email, cardType } = body;

    // Verify cardholder exists
    const existing = await query(`SELECT PkData FROM Card WHERE PkData = ${esc(id)}`);
    if (!existing.length) return res.status(404).json({ error: 'User not found' });

    let updated = 0;
    const adsSets = [];

    // Name and state changes must go through ADS
    if (name !== undefined)  { adsSets.push(`UserName = ${escStr(name)}`); updated++; }
    if (state !== undefined) { adsSets.push(`State = ${esc(state)}`);      updated++; }

    if (adsSets.length) {
      await execute(`UPDATE Card SET ${adsSets.join(', ')} WHERE PkData = ${esc(id)}`);
    }

    // All other fields go through SmartService PUT
    const ssFields = {};
    if (email !== undefined)        { ssFields.Email = email;           updated++; }
    if (cardType !== undefined)     { ssFields.CardType = cardType;     updated++; }
    if (body.cardInfo1 !== undefined) { ssFields.CardInfo1 = body.cardInfo1; updated++; }
    if (body.cardInfo2 !== undefined) { ssFields.CardInfo2 = body.cardInfo2; updated++; }
    if (body.cardInfo3 !== undefined) { ssFields.CardInfo3 = body.cardInfo3; updated++; }
    if (body.cardInfo4 !== undefined) { ssFields.CardInfo4 = body.cardInfo4; updated++; }
    if (body.cardInfo5 !== undefined) { ssFields.CardInfo5 = body.cardInfo5; updated++; }
    if (body.uuid !== undefined)      { ssFields.CardInfo20 = body.uuid;     updated++; }
    if (body.physicalKeys !== undefined) { ssFields.CardInfo3 = body.physicalKeys; updated++; }
    if (body.cesKey !== undefined)    { ssFields.CardInfo4 = body.cesKey;    updated++; }
    if (body.cmsKey !== undefined)    { ssFields.CardInfo8 = body.cmsKey;    updated++; }
    if (body.sesKey !== undefined)    { ssFields.CardInfo9 = body.sesKey;    updated++; }

    if (!updated) {
      return res.status(400).json({ error: 'No recognised fields to update' });
    }

    if (Object.keys(ssFields).length) {
      // PUT to SmartService with non-name fields
      await ss.updateCard(id, ssFields);
    } else if (adsSets.length) {
      // ADS-only change: send a no-op PUT to flush SmartService cache
      await ss.updateCardFull(id, {}, []);
    }

    res.json({ ok: true, id, updated });
  } catch (err) {
    console.error('PUT /users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

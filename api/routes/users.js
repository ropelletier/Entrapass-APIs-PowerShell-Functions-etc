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
 * POST /api/v1/users                      create new cardholder
 * PUT  /api/v1/users/:id                  update cardholder fields
 */

'use strict';

const router = require('express').Router();
const { query, execute, esc, escStr } = require('../db');
const { queryDay, enrichEvents } = require('./events');
const { mapOutbound, mapInbound } = require('../field-map');

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
  c.CardNumberCount       AS CardCount,
  n.CardNumberFormatted   AS CardNumber,
  n.CardNumber            AS CardNumberRaw,
  n.LostStolen            AS CardLostStolen,
  n.Deactivated           AS CardDeactivated,
  n.UseEndDate            AS CardHasExpiry,
  n.EndDate               AS CardEndDate,
  al.Description1         AS AccessLevel
FROM Card c
LEFT OUTER JOIN CardNumber  n  ON c.PkData = n.PkCard
LEFT OUTER JOIN ItemCard    ic ON c.PkData = ic.FkDataCard
LEFT OUTER JOIN AccessLevel al ON ic.FkICDataAccessLevel = al.PkData
`;

const STATE_LABELS = { '0': 'Active', '1': 'Lost/Stolen', '2': 'Inactive' };

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
        cardCount: parseInt(r.CardCount, 10) || 0,
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
    let where = '';

    if (name) {
      where = `WHERE UPPER(c.UserName) LIKE UPPER(${escStr('%' + name + '%')})`;
    } else if (card) {
      where = `WHERE n.CardNumberFormatted = ${escStr(card)} OR n.CardNumber = ${escStr(card)}`;
    } else if (state !== undefined) {
      where = `WHERE c.State = ${esc(state)}`;
    } else if (access_level) {
      where = `WHERE UPPER(al.Description1) LIKE UPPER(${escStr('%' + access_level + '%')})`;
    }

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
// POST /api/v1/users — create a new cardholder in EntraPass ADS
//
// Required body: { name }
// Optional:      { id, state, email, externalId, info1..4,
//                  startDate, endDate, cardType, accessLevel }
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const body = mapInbound(req.body);
    const {
      name,
      state      = '0',
      email      = '',
      externalId = '',
      startDate,
      endDate,
      cardType,
      accessLevel,
    } = body;
    // Info1-4 are integer columns in ADS. Convention: Info1 = PkData, rest = 0.
    // Accept user overrides but clamp to integer.
    const toInt = (v, def) => (v !== undefined && !isNaN(Number(v))) ? Number(v) : def;

    if (!name) return res.status(400).json({ error: 'name is required' });

    // Auto-assign PkData if not provided
    let pkData = body.id ? parseInt(body.id, 10) : null;
    if (!pkData) {
      const maxRows = await query('SELECT MAX(PkData) AS MaxID FROM Card');
      pkData = (parseInt((maxRows[0] && maxRows[0].MaxID) || '0', 10) || 0) + 1;
    }

    // Resolve optional FKs
    const ctId = cardType    ? await resolveCardType(cardType)       : null;
    const alId = accessLevel ? await resolveAccessLevel(accessLevel) : null;

    // Build Card INSERT
    // ExternalUserID is a numeric column — default 0, accept numeric strings
    const extIdNum = (externalId && !isNaN(Number(externalId))) ? Number(externalId) : 0;

    const i1 = toInt(body.info1, pkData);  // convention: Info1 = PkData
    const i2 = toInt(body.info2, 0);
    const i3 = toInt(body.info3, 0);
    const i4 = toInt(body.info4, 0);

    const cols = ['PkData', 'UserName', 'State', 'Email', 'ExternalUserID',
                  'Info1', 'Info2', 'Info3', 'Info4'];
    const vals = [pkData, escStr(name), esc(state), escStr(email), extIdNum,
                  i1, i2, i3, i4];

    if (startDate !== undefined) { cols.push('StartDate');    vals.push(escStr(startDate)); }
    if (endDate   !== undefined) { cols.push('EndDate');      vals.push(escStr(endDate));
                                   cols.push('UsingEndDate'); vals.push(1); }
    if (ctId      !== null)      { cols.push('FkCardType');   vals.push(ctId); }

    await execute(`INSERT INTO Card (${cols.join(', ')}) VALUES (${vals.join(', ')})`);

    // Create ItemCard row (access level assignment)
    if (alId !== null) {
      await execute(
        `INSERT INTO ItemCard (FkDataCard, FkDataGSI, ObjectCard, FkICDataAccessLevel,
           FkICDataAccessLevel1, ICDataWhenExpired1,
           FkICDataAccessLevel2, ICDataWhenExpired2,
           FkICDataAccessLevel3, ICDataWhenExpired3,
           FkICDataAccessLevel4, ICDataWhenExpired4,
           FkICDataAccessLevel5, ICDataWhenExpired5,
           FkICDataAccessLevel6, ICDataWhenExpired6,
           FkICDataAccessLevel7, ICDataWhenExpired7,
           FkICDataAccessLevel8, ICDataWhenExpired8,
           FkICDataAccessLevel9, ICDataWhenExpired9,
           FkICDataAccessLevel10, ICDataWhenExpired10,
           FkICDataAccessLevel11, ICDataWhenExpired11,
           FkICDataAccessLevel12, ICDataWhenExpired12,
           CDataExpired, FkICDataSchedule, DoorExceptionMode, FkICDataPanelComponent)
         VALUES (${pkData}, 67, 38, ${alId},
           0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
           0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
           0, 0, 0, 0)`
      );
    }

    res.status(201).json({ id: pkData, name, state, email, externalId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Lookup helpers — resolve access level or card type by name or numeric ID
// ---------------------------------------------------------------------------

async function resolveAccessLevel(nameOrId) {
  if (!isNaN(Number(nameOrId))) return Number(nameOrId);
  const rows = await query(
    `SELECT PkData FROM AccessLevel WHERE UPPER(Description1) = UPPER(${escStr(nameOrId)})`
  );
  if (!rows.length) throw new Error(`Access level not found: ${nameOrId}`);
  return parseInt(rows[0].PkData, 10);
}

async function resolveCardType(nameOrId) {
  if (!isNaN(Number(nameOrId))) return Number(nameOrId);
  const rows = await query(
    `SELECT PkData FROM CardType WHERE UPPER(Description1) = UPPER(${escStr(nameOrId)})`
  );
  if (!rows.length) throw new Error(`Card type not found: ${nameOrId}`);
  return parseInt(rows[0].PkData, 10);
}

// ---------------------------------------------------------------------------
// PUT /api/v1/users/:id — update cardholder fields
//
// Card table:    name, state, email, externalId, info1..4, cardInfo1..5,
//                startDate, endDate, cardType
// ItemCard table: accessLevel, accessException, accessExceptionExpiry
// Only supplied fields are updated.
// ---------------------------------------------------------------------------
router.put('/:id', async (req, res) => {
  try {
    const id   = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'id must be a number' });
    const body = mapInbound(req.body);

    // --- Card table ---
    // String columns on Card
    const cardStringMap = {
      name:      'UserName',
      state:     'State',
      email:     'Email',
      cardInfo1: 'CardInfo1', cardInfo2: 'CardInfo2', cardInfo3: 'CardInfo3',
      cardInfo4: 'CardInfo4', cardInfo5: 'CardInfo5',
    };
    // Integer columns on Card
    const cardIntMap = { info1: 'Info1', info2: 'Info2', info3: 'Info3', info4: 'Info4' };

    const cardSets = [];
    for (const [bodyKey, colName] of Object.entries(cardStringMap)) {
      if (body[bodyKey] !== undefined) cardSets.push(`${colName} = ${escStr(body[bodyKey])}`);
    }
    for (const [bodyKey, colName] of Object.entries(cardIntMap)) {
      if (body[bodyKey] !== undefined && !isNaN(Number(body[bodyKey]))) {
        cardSets.push(`${colName} = ${Number(body[bodyKey])}`);
      }
    }
    // ExternalUserID is numeric in ADS
    if (body.externalId !== undefined) {
      const extNum = (!isNaN(Number(body.externalId)) && body.externalId !== '')
        ? Number(body.externalId) : 0;
      cardSets.push(`ExternalUserID = ${extNum}`);
    }
    if (body.startDate !== undefined) {
      cardSets.push(`StartDate = ${escStr(body.startDate)}`);
    }
    if (body.endDate !== undefined) {
      cardSets.push(`EndDate = ${escStr(body.endDate)}, UsingEndDate = 1`);
    }
    if (body.cardType !== undefined) {
      const ctId = await resolveCardType(body.cardType);
      cardSets.push(`FkCardType = ${ctId}`);
    }

    // --- ItemCard table ---
    const itemSets = [];
    if (body.accessLevel !== undefined) {
      const alId = await resolveAccessLevel(body.accessLevel);
      itemSets.push(`FkICDataAccessLevel = ${alId}`);
    }
    if (body.accessException !== undefined) {
      const aeId = body.accessException
        ? await resolveAccessLevel(body.accessException)
        : 0;
      itemSets.push(`FkICDataAccessLevel1 = ${aeId}`);
      itemSets.push(`DoorExceptionMode = ${aeId ? 1 : 0}`);
    }
    if (body.accessExceptionExpiry !== undefined) {
      itemSets.push(`ICDataExpiration1 = ${escStr(body.accessExceptionExpiry)}`);
    }

    if (!cardSets.length && !itemSets.length) {
      return res.status(400).json({ error: 'No recognised fields to update' });
    }

    if (cardSets.length) {
      await execute(`UPDATE Card SET ${cardSets.join(', ')} WHERE PkData = ${id}`);
    }
    if (itemSets.length) {
      await execute(`UPDATE ItemCard SET ${itemSets.join(', ')} WHERE FkDataCard = ${id}`);
    }

    res.json({ ok: true, id, updated: cardSets.length + itemSets.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

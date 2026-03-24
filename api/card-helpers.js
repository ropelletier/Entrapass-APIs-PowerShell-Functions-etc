'use strict';

const { execute } = require('./db');

/**
 * Trigger the EntraPass gateway to push the updated card table to door controllers.
 *
 * Reverse-engineered: the desktop app INSERTs then immediately DELETEs a row in
 * CardLastAction keyed by the cardholder's PkData. EpCeServiceGateway watches
 * this table as a notification trigger.
 *
 * @param {string} pkCardEscaped  Already-escaped numeric PK (from esc())
 */
async function notifyGateway(pkCardEscaped) {
  try {
    await execute(`INSERT INTO CardLastAction (PkCardLastAction, SizeOfAction) VALUES (${pkCardEscaped}, 418)`);
    await execute(`DELETE FROM CardLastAction WHERE PkCardLastAction = ${pkCardEscaped}`);
  } catch (err) {
    console.error('notifyGateway error:', err.message);
  }
}

module.exports = { notifyGateway };

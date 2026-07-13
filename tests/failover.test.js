'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectAccountForSession, markAccountEmptyFailure, getAccounts, resetAccounts } = require('../server.js').__test;

test('empty-response failover: account_2 is selected after account_1 gets empty failures', () => {
  // Build a fresh 2-account pool (bypass fs loading).
  resetAccounts();
  const accounts = getAccounts();
  accounts.push(
    { id: 'account_1', file: 'a.json', config: { token: 't1', cookie: 'c1' }, headers: {}, cooldownUntil: 0, failures: 0, lastUsedAt: 0 },
    { id: 'account_2', file: 'b.json', config: { token: 't2', cookie: 'c2' }, headers: {}, cooldownUntil: 0, failures: 0, lastUsedAt: 0 },
  );

  const session = { id: null, parentMessageId: null, createdAt: null, messageCount: 0, accountId: null, history: [] };

  // First selection -> account_1 (round-robin starts at 0).
  const first = selectAccountForSession(session);
  assert.equal(first.id, 'account_1');
  assert.equal(session.accountId, 'account_1');

  // Simulate the retry loop: account_1 returns empty twice -> should enter cooldown
  // and the sticky accountId must be cleared so the next select picks account_2.
  markAccountEmptyFailure(accounts[0]); // 1st empty (no cooldown yet, limit is 2)
  assert.equal(accounts[0].cooldownUntil > Date.now(), false, 'account_1 should not cooldown after a single empty');
  session.accountId = null; // the retry loop clears the sticky id

  markAccountEmptyFailure(accounts[0]); // 2nd empty -> cooldown
  assert.equal(accounts[0].cooldownUntil > Date.now(), true, 'account_1 should cooldown after 2 empties');
  session.accountId = null;

  // Next selection should skip the cooling-down account_1 and pick account_2.
  const second = selectAccountForSession(session);
  assert.equal(second.id, 'account_2', 'failover should land on account_2');

  // If account_2 also fails twice, BOTH are cooling down and selection must throw.
  markAccountEmptyFailure(accounts[1]);
  session.accountId = null;
  markAccountEmptyFailure(accounts[1]); // account_2 now cooling down too
  session.accountId = null;
  assert.throws(() => selectAccountForSession(session), /cooling down|No valid/i);
});

test('single empty on account_1 does not immediately fail over (sticky until limit)', () => {
  resetAccounts();
  const accounts = getAccounts();
  accounts.push({ id: 'account_1', file: 'a.json', config: { token: 't1', cookie: 'c1' }, headers: {}, cooldownUntil: 0, failures: 0, lastUsedAt: 0 });
  const session = { id: null, accountId: null, history: [] };
  const a = selectAccountForSession(session);
  assert.equal(a.id, 'account_1');
  markAccountEmptyFailure(accounts[0]); // only 1 empty, limit is 2
  session.accountId = null;
  const b = selectAccountForSession(session);
  // Still account_1 (not yet cooled down), but that is fine: it only fails over on repeated empties.
  assert.equal(b.id, 'account_1');
});

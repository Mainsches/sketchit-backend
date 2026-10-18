import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashToken } from '../lib/auth.js';
import { createClock, createFakeOpenAI, createTestDatabase, setup, startServer } from './helpers.js';

const PROTECTED_ROUTES = [
  ['GET', '/usage'],
  ['GET', '/usage/some-session'],
  ['GET', '/session/some-session'],
  ['POST', '/session/some-session/premium'],
  ['GET', '/generation/gen_00000000000000000000000000000000'],
  ['POST', '/generation/start'],
  ['POST', '/generation/gen_00000000000000000000000000000000/variation'],
  ['POST', '/generate'],
];

test('protected routes reject missing and invalid credentials without calling OpenAI', async (t) => {
  const { api, openai } = await setup(t);
  const body = { prompt: 'a chair', sessionId: 'victim-session', deviceId: 'victim-device' };

  for (const [method, path] of PROTECTED_ROUTES) {
    const missing = await api.request(method, path, { body: method === 'POST' ? body : undefined });
    assert.equal(missing.status, 401, `${method} ${path} without token`);
    assert.equal(missing.body.code, 'AUTH_REQUIRED');
    assert.equal(missing.body.ok, false);
    assert.match(missing.headers.get('www-authenticate'), /^Bearer/);

    const malformed = await api.request(method, path, {
      body: method === 'POST' ? body : undefined,
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    assert.equal(malformed.status, 401, `${method} ${path} with non-bearer scheme`);
    assert.equal(malformed.body.code, 'AUTH_INVALID');

    const forged = await api.request(method, path, {
      body: method === 'POST' ? body : undefined,
      token: `mai_${'A'.repeat(43)}`,
    });
    assert.equal(forged.status, 401, `${method} ${path} with unknown token`);
    assert.equal(forged.body.code, 'AUTH_INVALID');
  }

  // sessionId / deviceId are labels, never credentials.
  const sessionOnly = await api.get('/usage/victim-session?deviceId=victim-device');
  assert.equal(sessionOnly.status, 401);
  assert.equal(openai.calls.length, 0);
});

test('revoked tokens are rejected', async (t) => {
  const { api, db } = await setup(t);
  const account = await api.issueAccount();
  assert.equal((await api.usage(account.accessToken)).status, 200);

  await db.query('UPDATE auth_tokens SET revoked_at = now() WHERE user_id = $1', [account.userId]);
  const response = await api.usage(account.accessToken);
  assert.equal(response.status, 401);
  assert.equal(response.body.code, 'AUTH_INVALID');
});

test('anonymous account issuance returns a random identity and stores only a token hash', async (t) => {
  const { api, db } = await setup(t);

  const first = await api.request('POST', '/auth/anonymous');
  const second = await api.request('POST', '/auth/anonymous');
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  for (const response of [first, second]) {
    assert.equal(response.body.ok, true);
    assert.match(response.body.userId, /^usr_[0-9a-f]{32}$/);
    assert.match(response.body.accessToken, /^mai_[A-Za-z0-9_-]{43}$/);
    assert.equal(response.body.tokenType, 'Bearer');
    assert.equal(response.body.accountType, 'anonymous');
    assert.equal(response.body.recoverable, false);
    assert.equal(response.body.usage.remainingToStart, 3);
    assert.equal(response.body.usage.isPremium, false);
  }
  assert.notEqual(first.body.userId, second.body.userId);
  assert.notEqual(first.body.accessToken, second.body.accessToken);

  const { rows } = await db.query('SELECT user_id, token_hash FROM auth_tokens ORDER BY created_at');
  assert.equal(rows.length, 2);
  const stored = rows.find((row) => row.user_id === first.body.userId);
  assert.equal(stored.token_hash, hashToken(first.body.accessToken));
  assert.notEqual(stored.token_hash, first.body.accessToken);

  const dump = JSON.stringify((await db.query('SELECT * FROM auth_tokens')).rows);
  assert.ok(!dump.includes(first.body.accessToken), 'raw token must not be persisted');
  assert.ok(!dump.includes(second.body.accessToken), 'raw token must not be persisted');

  const usage = await api.usage(first.body.accessToken);
  assert.equal(usage.status, 200);
  assert.equal(usage.body.usage.userId, first.body.userId);
});

test('identity and quota usage persist across a server and database restart', async (t) => {
  const handle = await createTestDatabase();
  t.after(() => handle.destroy());
  const clock = createClock('2026-10-17T10:00:00.000Z');
  const openai = createFakeOpenAI();

  let db = await handle.open();
  let server = await startServer({ db, openai, clock });
  const account = await server.api.issueAccount();
  const started = await server.api.startGeneration(account.accessToken);
  assert.equal(started.status, 200);
  await server.service.waitForIdle();
  await server.close();
  await db.close();

  db = await handle.open();
  server = await startServer({ db, openai, clock });
  t.after(async () => {
    await server.close();
    await db.close();
  });

  const usage = await server.api.usage(account.accessToken);
  assert.equal(usage.status, 200);
  assert.equal(usage.body.usage.userId, account.userId);
  assert.equal(usage.body.usage.dailyCount, 1);
  assert.equal(usage.body.usage.remainingToStart, 2);

  const generation = await server.api.get(`/generation/${started.body.generation.id}`, { token: account.accessToken });
  assert.equal(generation.status, 200);
  assert.equal(generation.body.generation.status, 'done');
});

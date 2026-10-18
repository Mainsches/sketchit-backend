import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, waitFor } from './helpers.js';

test('first three free starts are accepted and the fourth is rejected', async (t) => {
  const { api, openai, service } = await setup(t, { openaiOptions: { mode: 'manual' } });
  const { accessToken } = await api.issueAccount();

  for (let index = 0; index < 3; index += 1) {
    const response = await api.startGeneration(accessToken);
    assert.equal(response.status, 200, `start ${index + 1}`);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.generation.status, 'pending');
    assert.equal(response.body.usage.pendingCount, index + 1);
    assert.equal(response.body.usage.remainingToStart, 2 - index);
  }

  const fourth = await api.startGeneration(accessToken);
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.code, 'DAILY_LIMIT_REACHED');
  assert.equal(fourth.body.usage.remainingToStart, 0);
  assert.equal(fourth.body.usage.canStartGeneration, false);

  await waitFor(() => openai.pendingCount() === 3);
  for (let index = 0; index < 3; index += 1) openai.resolveNext();
  await service.waitForIdle();

  const fifth = await api.startGeneration(accessToken);
  assert.equal(fifth.status, 429);
  const usage = await api.usage(accessToken);
  assert.equal(usage.body.usage.dailyCount, 3);
  assert.equal(usage.body.usage.pendingCount, 0);
  assert.equal(usage.body.usage.remainingToday, 0);
  assert.equal(openai.calls.length, 3);
});

test('concurrent starts cannot exceed the daily quota', async (t) => {
  const { api, openai, db, service } = await setup(t, { openaiOptions: { mode: 'manual' } });
  const { accessToken, userId } = await api.issueAccount();

  const responses = await Promise.all(Array.from({ length: 12 }, () => api.startGeneration(accessToken)));
  const accepted = responses.filter((response) => response.status === 200);
  const rejected = responses.filter((response) => response.status === 429);
  assert.equal(accepted.length, 3);
  assert.equal(rejected.length, 9);
  assert.ok(rejected.every((response) => response.body.code === 'DAILY_LIMIT_REACHED'));

  const { rows } = await db.query('SELECT free_consumed, free_pending FROM daily_usage WHERE user_id = $1', [userId]);
  assert.deepEqual(rows, [{ free_consumed: 0, free_pending: 3 }]);
  const generations = await db.query('SELECT count(*)::int AS count FROM generations WHERE user_id = $1', [userId]);
  assert.equal(generations.rows[0].count, 3);

  await waitFor(() => openai.pendingCount() === 3);
  assert.equal(openai.calls.length, 3);
  for (let index = 0; index < 3; index += 1) openai.resolveNext();
  await service.waitForIdle();
});

test('concurrent starts and completions across users stay within quota without errors', async (t) => {
  const { api, openai, db, service } = await setup(t);
  const accounts = await Promise.all(Array.from({ length: 5 }, () => api.issueAccount()));

  const responses = await Promise.all(
    accounts.flatMap((account) => Array.from({ length: 8 }, () => api.startGeneration(account.accessToken)))
  );
  await service.waitForIdle();

  assert.deepEqual(
    [...new Set(responses.map((response) => response.status))].sort(),
    [200, 429],
    'only accepted or quota-rejected responses are expected'
  );
  for (const account of accounts) {
    const usage = (await api.usage(account.accessToken)).body.usage;
    assert.equal(usage.dailyCount, 3);
    assert.equal(usage.pendingCount, 0);
  }
  assert.equal(openai.calls.length, 15);
  const { rows } = await db.query("SELECT count(*)::int AS count FROM generations WHERE status = 'done'");
  assert.equal(rows[0].count, 15);
});

test('a failed generation releases its reservation and exposes only a safe error', async (t) => {
  const { api, openai, service } = await setup(t, { openaiOptions: { mode: 'fail' } });
  const { accessToken } = await api.issueAccount();

  const started = await api.startGeneration(accessToken);
  assert.equal(started.status, 200);
  assert.equal(started.body.usage.pendingCount, 1);
  await service.waitForIdle();

  const generation = await api.get(`/generation/${started.body.generation.id}`, { token: accessToken });
  assert.equal(generation.body.generation.status, 'error');
  assert.equal(generation.body.generation.error.code, 'GENERATION_FAILED');
  assert.doesNotMatch(generation.text, /sk-should-not-leak|Upstream failure/);
  assert.equal(generation.body.generation.usageSnapshot.dailyCount, 0);
  assert.equal(generation.body.generation.usageSnapshot.pendingCount, 0);
  assert.equal(generation.body.generation.usageSnapshot.remainingToStart, 3);

  // Three more failures still never exhaust the quota.
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await api.startGeneration(accessToken)).status, 200);
    await service.waitForIdle();
  }
  openai.setMode('success');
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await api.startGeneration(accessToken)).status, 200);
  }
  await service.waitForIdle();
  assert.equal((await api.startGeneration(accessToken)).status, 429);
});

test('a successful generation consumes exactly one free slot', async (t) => {
  const { api, service, db } = await setup(t);
  const { accessToken, userId } = await api.issueAccount();

  const started = await api.startGeneration(accessToken);
  assert.equal(started.status, 200);
  assert.equal(started.body.usage.pendingCount, 1);
  assert.equal(started.body.usage.dailyCount, 0);
  await service.waitForIdle();

  const usage = (await api.usage(accessToken)).body.usage;
  assert.equal(usage.dailyCount, 1);
  assert.equal(usage.pendingCount, 0);
  assert.equal(usage.remainingToday, 2);
  assert.equal(usage.remainingToStart, 2);
  assert.equal(usage.totalCount, 1);

  const generation = await api.get(`/generation/${started.body.generation.id}`, { token: accessToken });
  assert.equal(generation.body.generation.status, 'done');
  assert.match(generation.body.generation.imageDataUrl, /^data:image\/png;base64,/);
  assert.ok(generation.body.generation.imageBase64);

  const { rows } = await db.query('SELECT free_consumed, free_pending FROM daily_usage WHERE user_id = $1', [userId]);
  assert.deepEqual(rows, [{ free_consumed: 1, free_pending: 0 }]);
});

test('reservations stay on their original UTC day across midnight', async (t) => {
  const { api, openai, service, clock, db } = await setup(t, {
    openaiOptions: { mode: 'manual' },
    server: { config: { jobLeaseMs: 600_000 } },
  });
  const { accessToken, userId } = await api.issueAccount();

  clock.set('2026-10-17T23:59:58.000Z');
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await api.startGeneration(accessToken)).status, 200);
  }
  assert.equal((await api.startGeneration(accessToken)).status, 429);
  const before = (await api.usage(accessToken)).body.usage;
  assert.equal(before.resetDayKey, '2026-10-17');
  assert.equal(before.resetsAt, '2026-10-18T00:00:00.000Z');

  clock.set('2026-10-18T00:00:01.000Z');
  const afterMidnight = (await api.usage(accessToken)).body.usage;
  assert.equal(afterMidnight.resetDayKey, '2026-10-18');
  assert.equal(afterMidnight.remainingToStart, 3);

  // Yesterday's jobs finish today; they settle against yesterday only.
  await waitFor(() => openai.pendingCount() === 3);
  openai.resolveNext();
  openai.resolveNext();
  openai.rejectNext();
  await service.waitForIdle();

  const { rows } = await db.query(
    'SELECT usage_day, free_consumed, free_pending FROM daily_usage WHERE user_id = $1 ORDER BY usage_day',
    [userId]
  );
  assert.deepEqual(rows, [{ usage_day: '2026-10-17', free_consumed: 2, free_pending: 0 }]);

  const today = (await api.usage(accessToken)).body.usage;
  assert.equal(today.dailyCount, 0);
  assert.equal(today.remainingToStart, 3);

  openai.setMode('success');
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await api.startGeneration(accessToken)).status, 200);
  }
  assert.equal((await api.startGeneration(accessToken)).status, 429);
  await service.waitForIdle();
});

test('duplicate idempotency keys replay the original generation without a second start or charge', async (t) => {
  const { api, openai, service, db } = await setup(t, { openaiOptions: { mode: 'manual' } });
  const { accessToken, userId } = await api.issueAccount();
  const body = { prompt: 'a grey wood sideboard', sessionId: 'session-a' };

  const first = await api.startGeneration(accessToken, { key: 'retry-key-0001', body });
  const retry = await api.startGeneration(accessToken, { key: 'retry-key-0001', body });
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotentReplay, true);
  assert.equal(retry.headers.get('idempotent-replayed'), 'true');
  assert.equal(retry.body.generation.id, first.body.generation.id);
  assert.equal(retry.body.usage.pendingCount, 1);

  const concurrent = await Promise.all(
    Array.from({ length: 6 }, () => api.startGeneration(accessToken, { key: 'retry-key-0002', body }))
  );
  assert.ok(concurrent.every((response) => response.status === 200));
  assert.equal(new Set(concurrent.map((response) => response.body.generation.id)).size, 1);

  const conflict = await api.startGeneration(accessToken, {
    key: 'retry-key-0001',
    body: { prompt: 'something else entirely' },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'IDEMPOTENCY_KEY_REUSED');

  const missingKey = await api.post('/generation/start', { token: accessToken, body });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.body.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const badKey = await api.post('/generation/start', { token: accessToken, body, headers: { 'idempotency-key': 'x' } });
  assert.equal(badKey.status, 400);
  assert.equal(badKey.body.code, 'INVALID_IDEMPOTENCY_KEY');

  await waitFor(() => openai.pendingCount() === 2);
  assert.equal(openai.calls.length, 2);
  const { rows } = await db.query('SELECT free_pending FROM daily_usage WHERE user_id = $1', [userId]);
  assert.equal(rows[0].free_pending, 2);

  openai.resolveNext();
  openai.resolveNext();
  await service.waitForIdle();

  const afterCompletion = await api.startGeneration(accessToken, { key: 'retry-key-0001', body });
  assert.equal(afterCompletion.status, 200);
  assert.equal(afterCompletion.body.generation.status, 'done');
  assert.equal(afterCompletion.body.usage.dailyCount, 2);
  assert.equal(openai.calls.length, 2);

  // Keys are scoped per user: another user may reuse the same key independently.
  const other = await api.issueAccount();
  const otherStart = await api.startGeneration(other.accessToken, { key: 'retry-key-0001', body });
  assert.equal(otherStart.status, 200);
  assert.notEqual(otherStart.body.generation.id, first.body.generation.id);
  await waitFor(() => openai.pendingCount() === 1);
  openai.resolveNext();
  await service.waitForIdle();
});

test('the database rejects invalid counters and free rows for paid modes', async (t) => {
  const { api, db } = await setup(t);
  const { accessToken, userId } = await api.issueAccount();
  await api.usage(accessToken);

  await db.query(
    `INSERT INTO daily_usage (user_id, usage_day, free_consumed, free_pending, updated_at)
     VALUES ($1, '2026-10-17', 0, 0, now())`,
    [userId]
  );

  await assert.rejects(
    db.query(`UPDATE daily_usage SET free_pending = free_pending - 1 WHERE user_id = $1`, [userId]),
    (error) => error.code === '23514'
  );
  await assert.rejects(
    db.query(`UPDATE daily_usage SET free_consumed = -1 WHERE user_id = $1`, [userId]),
    (error) => error.code === '23514'
  );
  await assert.rejects(
    db.query(`UPDATE daily_usage SET free_consumed = 3, free_pending = 1 WHERE user_id = $1`, [userId]),
    (error) => error.code === '23514'
  );
  await assert.rejects(
    db.query(
      `INSERT INTO generations (id, user_id, request_hash, kind, mode, generation_mode, funding_source, quota_day,
                                status, has_sketch, created_at, started_at, updated_at)
       VALUES ('gen_0123456789abcdef0123456789abcdef', $1, 'h', 'base', 'architect', 'balanced', 'free_daily',
               '2026-10-17', 'pending', false, now(), now(), now())`,
      [userId]
    ),
    (error) => error.code === '23514'
  );
  await assert.rejects(
    db.query(
      `INSERT INTO generations (id, user_id, request_hash, kind, mode, generation_mode, funding_source, quota_day,
                                status, has_sketch, created_at, started_at, updated_at)
       VALUES ('gen_0123456789abcdef0123456789abcdee', $1, 'h', 'base', 'product', 'balanced', 'coin',
               '2026-10-17', 'pending', false, now(), now(), now())`,
      [userId]
    ),
    (error) => error.code === '23514'
  );
});

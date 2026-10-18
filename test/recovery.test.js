import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock, createFakeOpenAI, createTestDatabase, startServer, waitFor } from './helpers.js';

const LEASE_MS = 90_000;

test('jobs interrupted by a restart are failed and their reservations released', async (t) => {
  const handle = await createTestDatabase();
  t.after(() => handle.destroy());
  const clock = createClock('2026-10-17T08:00:00.000Z');

  // First process: starts a job, then "crashes" before OpenAI answers.
  const crashedOpenAI = createFakeOpenAI({ mode: 'manual', honourAbort: false });
  let db = await handle.open();
  let server = await startServer({ db, openai: crashedOpenAI, clock, workerId: 'wrk_crashed' });
  const account = await server.api.issueAccount();
  const started = await server.api.startGeneration(account.accessToken);
  assert.equal(started.status, 200);
  await waitFor(() => crashedOpenAI.pendingCount() === 1);
  await server.close();
  await db.close();

  // Second process: same database, new worker.
  const openai = createFakeOpenAI();
  db = await handle.open();
  server = await startServer({ db, openai, clock, workerId: 'wrk_restarted' });
  t.after(async () => {
    await server.close();
    await db.close();
  });

  const beforeLeaseExpiry = await server.service.recoverInterruptedJobs();
  assert.equal(beforeLeaseExpiry, 0, 'a live lease must not be recovered');
  const pendingUsage = (await server.api.usage(account.accessToken)).body.usage;
  assert.equal(pendingUsage.pendingCount, 1);
  assert.equal(pendingUsage.remainingToStart, 2);

  clock.advance(LEASE_MS + 1);
  assert.equal(await server.service.recoverInterruptedJobs(), 1);
  assert.equal(await server.service.recoverInterruptedJobs(), 0, 'recovery is idempotent');

  const generation = await server.api.get(`/generation/${started.body.generation.id}`, { token: account.accessToken });
  assert.equal(generation.body.generation.status, 'error');
  assert.equal(generation.body.generation.error.code, 'INTERRUPTED');
  assert.equal(generation.body.generation.usageSnapshot.pendingCount, 0);
  assert.equal(generation.body.generation.usageSnapshot.dailyCount, 0);
  assert.equal(generation.body.generation.usageSnapshot.remainingToStart, 3);

  for (let index = 0; index < 3; index += 1) {
    assert.equal((await server.api.startGeneration(account.accessToken)).status, 200);
  }
  await server.service.waitForIdle();
  assert.equal((await server.api.usage(account.accessToken)).body.usage.dailyCount, 3);
});

test('a late result from a recovered job is discarded and never double-settles', async (t) => {
  const handle = await createTestDatabase();
  t.after(() => handle.destroy());
  const db = await handle.open();
  const clock = createClock('2026-10-17T08:00:00.000Z');
  const slowOpenAI = createFakeOpenAI({ mode: 'manual', honourAbort: false });

  const instanceA = await startServer({ db, openai: slowOpenAI, clock, workerId: 'wrk_a' });
  const instanceB = await startServer({ db, openai: createFakeOpenAI(), clock, workerId: 'wrk_b' });
  t.after(async () => {
    await instanceA.close();
    await instanceB.close();
    await db.close();
  });

  const account = await instanceA.api.issueAccount();
  const started = await instanceA.api.startGeneration(account.accessToken);
  await waitFor(() => slowOpenAI.pendingCount() === 1);

  // A live worker that renews its lease is not recovered by another instance.
  clock.advance(LEASE_MS / 2);
  assert.equal(await instanceA.service.renewLeases(), 1);
  clock.advance(LEASE_MS / 2 + 1);
  assert.equal(await instanceB.service.recoverInterruptedJobs(), 0);

  // Once instance A stops renewing, B recovers the job.
  clock.advance(LEASE_MS);
  assert.equal(await instanceB.service.recoverInterruptedJobs(), 1);

  slowOpenAI.resolveNext();
  await instanceA.service.waitForIdle();

  const generation = await instanceB.api.get(`/generation/${started.body.generation.id}`, { token: account.accessToken });
  assert.equal(generation.body.generation.status, 'error');
  assert.equal(generation.body.generation.imageDataUrl, null);
  const usage = generation.body.generation.usageSnapshot;
  assert.equal(usage.dailyCount, 0);
  assert.equal(usage.pendingCount, 0);
  assert.equal(usage.totalCount, 0);
});

test('a job finalised by recovery before its worker claims it never calls OpenAI', async (t) => {
  const handle = await createTestDatabase();
  t.after(() => handle.destroy());
  const db = await handle.open();
  const clock = createClock('2026-10-17T08:00:00.000Z');

  // Holds instance A's pending -> processing transition until the test releases it.
  let claimReached;
  let releaseClaim;
  const claimSeen = new Promise((resolve) => {
    claimReached = resolve;
  });
  const claimGate = new Promise((resolve) => {
    releaseClaim = resolve;
  });
  const gatedDb = {
    ...db,
    async query(text, params) {
      if (text.includes("SET status = 'processing'")) {
        claimReached();
        await claimGate;
      }
      return db.query(text, params);
    },
  };

  const openaiA = createFakeOpenAI();
  const openaiB = createFakeOpenAI();
  const instanceA = await startServer({ db: gatedDb, openai: openaiA, clock, workerId: 'wrk_a' });
  const instanceB = await startServer({ db, openai: openaiB, clock, workerId: 'wrk_b' });
  t.after(async () => {
    releaseClaim();
    await instanceA.close();
    await instanceB.close();
    await db.close();
  });

  const account = await instanceA.api.issueAccount();
  const started = await instanceA.api.startGeneration(account.accessToken);
  assert.equal(started.status, 200);
  await claimSeen;

  // Another instance recovers the job; instance A's abort signal is not triggered.
  clock.advance(LEASE_MS + 1);
  assert.equal(await instanceB.service.recoverInterruptedJobs(), 1);
  releaseClaim();
  await instanceA.service.waitForIdle();

  assert.equal(openaiA.calls.length, 0);
  assert.equal(openaiB.calls.length, 0);

  const generation = await instanceA.api.get(`/generation/${started.body.generation.id}`, { token: account.accessToken });
  assert.equal(generation.body.generation.status, 'error');
  assert.equal(generation.body.generation.error.code, 'INTERRUPTED');
  const { rows } = await db.query('SELECT free_consumed, free_pending FROM daily_usage WHERE user_id = $1', [
    account.userId,
  ]);
  assert.deepEqual(rows, [{ free_consumed: 0, free_pending: 0 }]);

  // The normal path on the same instance still claims the job and calls OpenAI once.
  const next = await instanceA.api.startGeneration(account.accessToken);
  assert.equal(next.status, 200);
  await instanceA.service.waitForIdle();
  assert.equal(openaiA.calls.length, 1);
  const done = await instanceA.api.get(`/generation/${next.body.generation.id}`, { token: account.accessToken });
  assert.equal(done.body.generation.status, 'done');
  assert.equal(done.body.generation.usageSnapshot.dailyCount, 1);
  assert.equal(done.body.generation.usageSnapshot.pendingCount, 0);
});

test('jobs exceeding the maximum duration are recovered even while their lease is renewed', async (t) => {
  const handle = await createTestDatabase();
  t.after(() => handle.destroy());
  const db = await handle.open();
  const clock = createClock('2026-10-17T08:00:00.000Z');
  const openai = createFakeOpenAI({ mode: 'manual' });
  const server = await startServer({ db, openai, clock, config: { jobTimeoutMs: 300_000, jobLeaseMs: LEASE_MS } });
  t.after(async () => {
    await server.close();
    await db.close();
  });

  const account = await server.api.issueAccount();
  await server.api.startGeneration(account.accessToken);
  await waitFor(() => openai.pendingCount() === 1);

  clock.advance(300_000 + LEASE_MS + 1);
  await server.service.renewLeases();
  assert.equal(await server.service.recoverInterruptedJobs(), 1);
  await server.service.waitForIdle();
  assert.equal(server.service.activeJobCount(), 0);
  assert.equal((await server.api.usage(account.accessToken)).body.usage.remainingToStart, 3);
});

test('graceful shutdown interrupts running jobs and releases their reservations', async (t) => {
  const handle = await createTestDatabase();
  t.after(() => handle.destroy());
  const db = await handle.open();
  const openai = createFakeOpenAI({ mode: 'manual' });
  const server = await startServer({ db, openai });
  t.after(async () => {
    await server.close();
    await db.close();
  });

  const account = await server.api.issueAccount();
  const started = await server.api.startGeneration(account.accessToken);
  await waitFor(() => openai.pendingCount() === 1);

  await server.service.interruptAll();

  const generation = await server.api.get(`/generation/${started.body.generation.id}`, { token: account.accessToken });
  assert.equal(generation.body.generation.status, 'error');
  assert.equal(generation.body.generation.error.code, 'INTERRUPTED');
  assert.equal(generation.body.generation.usageSnapshot.remainingToStart, 3);
});

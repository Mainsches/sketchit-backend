import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from '../lib/config.js';
import { runMigrations } from '../lib/migrate.js';
import { createClock, createFakeOpenAI, setup, silentLogger, startServer } from './helpers.js';

test('account issuance is rate limited per client IP', async (t) => {
  const { api, clock } = await setup(t, { server: { config: { authRateLimitPerHour: 2 } } });

  assert.equal((await api.post('/auth/anonymous')).status, 201);
  assert.equal((await api.post('/auth/anonymous')).status, 201);
  const limited = await api.post('/auth/anonymous');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);

  clock.advance(60 * 60 * 1000 + 1);
  assert.equal((await api.post('/auth/anonymous')).status, 201);
});

test('generation starts are rate limited per user', async (t) => {
  const { api, service } = await setup(t, { server: { config: { startRateLimitPer10Min: 2 } } });
  const alice = await api.issueAccount();
  const bob = await api.issueAccount();

  assert.equal((await api.startGeneration(alice.accessToken)).status, 200);
  assert.equal((await api.startGeneration(alice.accessToken)).status, 200);
  const limited = await api.startGeneration(alice.accessToken);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.equal((await api.startGeneration(bob.accessToken)).status, 200);
  await service.waitForIdle();
});

test('oversized and malformed requests are rejected with safe errors', async (t) => {
  const { api, openai } = await setup(t, { server: { config: { jsonBodyLimitBytes: 4096, maxSketchBytes: 1024 } } });
  const { accessToken } = await api.issueAccount();

  const tooLarge = await api.post('/generation/start', {
    token: accessToken,
    rawBody: JSON.stringify({ prompt: 'x'.repeat(5000) }),
    headers: { 'idempotency-key': 'payload-key-1' },
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.code, 'PAYLOAD_TOO_LARGE');

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000)]);
  const sketchTooLarge = await api.startGeneration(accessToken, { body: { imageBase64: png.toString('base64') } });
  assert.equal(sketchTooLarge.status, 413);
  assert.equal(sketchTooLarge.body.code, 'IMAGE_TOO_LARGE');

  const badJson = await api.post('/generation/start', {
    token: accessToken,
    rawBody: '{"prompt": ',
    headers: { 'idempotency-key': 'payload-key-2' },
  });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.code, 'INVALID_JSON');
  assert.doesNotMatch(badJson.text, /SyntaxError|at JSON\.parse|node_modules/);

  const unknownRoute = await api.get('/admin');
  assert.equal(unknownRoute.status, 404);
  assert.equal(unknownRoute.body.code, 'NOT_FOUND');

  assert.equal(openai.calls.length, 0);
});

test('unexpected internal errors return a generic response', async (t) => {
  const { db } = await setup(t);
  const failingDb = {
    ...db,
    async query(text, params) {
      if (text.includes('LEFT JOIN daily_usage')) {
        throw new Error('connection to postgres://admin:hunter2@db failed');
      }
      return db.query(text, params);
    },
  };
  const server = await startServer({ db: failingDb, openai: createFakeOpenAI() });
  t.after(() => server.close());

  const response = await server.api.post('/auth/anonymous');
  assert.equal(response.status, 500);
  assert.equal(response.body.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(response.text, /hunter2|postgres:\/\/|at /);
});

test('configuration requires secrets and validates values without echoing them', () => {
  assert.throws(
    () => loadConfig({}),
    (error) =>
      error instanceof ConfigError &&
      error.problems.includes('OPENAI_API_KEY is required.') &&
      error.problems.includes('DATABASE_URL is required.')
  );

  assert.throws(
    () => loadConfig({ OPENAI_API_KEY: 'sk-secret-value', DATABASE_URL: 'mysql://user:secretpw@host/db' }),
    (error) => error instanceof ConfigError && !error.message.includes('secretpw') && !error.message.includes('sk-secret-value')
  );

  const base = { OPENAI_API_KEY: 'sk-test', DATABASE_URL: 'postgres://u:p@localhost:5432/db' };
  assert.throws(
    () => loadConfig({ ...base, NODE_ENV: 'production' }),
    (error) => error.problems.some((problem) => problem.startsWith('TRUST_PROXY is required'))
  );
  assert.throws(() => loadConfig({ ...base, TRUST_PROXY: 'true' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, PORT: 'abc' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, CORS_ORIGINS: '*' }), ConfigError);

  const config = loadConfig({ ...base, NODE_ENV: 'production', TRUST_PROXY: '1', CORS_ORIGINS: 'https://app.example' });
  assert.equal(config.trustProxy, 1);
  assert.equal(config.isProduction, true);
  assert.deepEqual(config.corsOrigins, ['https://app.example']);
  assert.ok(Object.isFrozen(config));
});

test('retention purges old images, then old records and usage rows', async (t) => {
  const { api, service, clock, db } = await setup(t);
  const { accessToken, userId } = await api.issueAccount();
  const started = await api.startGeneration(accessToken);
  await service.waitForIdle();
  const path = `/generation/${started.body.generation.id}`;

  assert.deepEqual(await service.cleanupRetention(), { imagesPurged: 0, recordsDeleted: 0, usageRowsDeleted: 0 });

  clock.advance(25 * 60 * 60 * 1000);
  const afterImageRetention = await service.cleanupRetention();
  assert.equal(afterImageRetention.imagesPurged, 1);
  const purged = await api.get(path, { token: accessToken });
  assert.equal(purged.status, 200);
  assert.equal(purged.body.generation.status, 'done');
  assert.equal(purged.body.generation.imageDataUrl, null);
  assert.equal(purged.body.generation.imageExpired, true);

  clock.advance(30 * 24 * 60 * 60 * 1000);
  assert.equal((await service.cleanupRetention()).recordsDeleted, 1);
  assert.equal((await api.get(path, { token: accessToken })).status, 404);

  clock.advance(90 * 24 * 60 * 60 * 1000);
  assert.equal((await service.cleanupRetention()).usageRowsDeleted, 1);
  const { rows } = await db.query('SELECT count(*)::int AS count FROM daily_usage WHERE user_id = $1', [userId]);
  assert.equal(rows[0].count, 0);
  assert.equal((await api.usage(accessToken)).body.usage.totalCount, 1);
});

test('migrations are recorded, idempotent and tamper-evident', async (t) => {
  const { db } = await setup(t);

  assert.deepEqual(await runMigrations(db, { logger: silentLogger }), []);
  const { rows } = await db.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows.map((row) => row.version), ['001_initial_schema', '002_restrict_data_api_access']);

  await db.query(`UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '001_initial_schema'`);
  await assert.rejects(runMigrations(db, { logger: silentLogger }), /was modified after it was applied/);
});

test('public informational routes keep their contract', async (t) => {
  const { api } = await setup(t);

  const root = await api.get('/');
  assert.deepEqual(root.body, { ok: true, message: 'SketchIT backend is running' });

  const health = await api.get('/health');
  assert.equal(health.status, 200);

  const plans = await api.get('/plans');
  assert.equal(plans.body.plans.free.dailyLimit, 3);
  assert.deepEqual(plans.body.plans.free.modes, ['balanced']);
  assert.equal(plans.body.plans.premium.available, false);
});

test('CORS headers are only sent for configured origins', async (t) => {
  const { db } = await setup(t);
  const server = await startServer({
    db,
    openai: createFakeOpenAI(),
    clock: createClock(),
    config: { corsOrigins: ['https://allowed.example'] },
  });
  t.after(() => server.close());

  const allowed = await server.api.get('/', { headers: { origin: 'https://allowed.example' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://allowed.example');
  const denied = await server.api.get('/', { headers: { origin: 'https://evil.example' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

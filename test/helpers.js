import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../lib/app.js';
import { buildTestConfig } from '../lib/config.js';
import { isLoopbackDatabaseUrl } from '../lib/databaseTarget.js';
import { createPostgresDatabase } from '../lib/db.js';
import { runMigrations } from '../lib/migrate.js';

export const silentLogger = process.env.TEST_VERBOSE ? console : { info() {}, warn() {}, error() {}, log() {} };

export const FAKE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export const usingRealPostgres = Boolean(process.env.TEST_DATABASE_URL);

// Tests create and drop schemas, so they only run against a local throwaway server.
if (usingRealPostgres && !isLoopbackDatabaseUrl(process.env.TEST_DATABASE_URL)) {
  throw new Error('TEST_DATABASE_URL must point to a local throwaway database (localhost, 127.0.0.1 or ::1).');
}

function wrapPglite(pglite) {
  const wrap = (queryable) => ({
    async query(text, params = []) {
      const result = await queryable.query(text, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
    },
    async exec(sql) {
      await queryable.exec(sql);
    },
  });
  return {
    dialect: 'pglite',
    ...wrap(pglite),
    transaction: (fn) => pglite.transaction((tx) => fn(wrap(tx))),
    close: () => pglite.close(),
  };
}

/**
 * Returns a handle whose open() can be called again after close() to simulate
 * a server restart against the same persisted database.
 */
export async function createTestDatabase() {
  if (usingRealPostgres) {
    const connectionString = process.env.TEST_DATABASE_URL;
    const schema = `test_${randomBytes(6).toString('hex')}`;
    const admin = createPostgresDatabase({ connectionString, max: 1, logger: silentLogger });
    await admin.exec(`CREATE SCHEMA ${schema}`);
    await admin.close();

    let migrated = false;
    return {
      async open() {
        const db = createPostgresDatabase({
          connectionString,
          max: 20,
          options: `-c search_path=${schema}`,
          logger: silentLogger,
        });
        if (!migrated) {
          await runMigrations(db, { logger: silentLogger });
          migrated = true;
        }
        return db;
      },
      async destroy() {
        const cleanup = createPostgresDatabase({ connectionString, max: 1, logger: silentLogger });
        await cleanup.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await cleanup.close();
      },
    };
  }

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mainsches-test-'));
  let migrated = false;
  return {
    async open() {
      const pglite = await PGlite.create(dataDir, { parsers: { 1082: (value) => value } });
      const db = wrapPglite(pglite);
      if (!migrated) {
        await runMigrations(db, { logger: silentLogger });
        migrated = true;
      }
      return db;
    },
    async destroy() {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export function createClock(startIso = '2026-10-17T12:00:00.000Z') {
  let current = Date.parse(startIso);
  return {
    now: () => current,
    set(iso) {
      current = Date.parse(iso);
    },
    advance(ms) {
      current += ms;
    },
  };
}

/**
 * Fake OpenAI client. Modes:
 *   success - every call resolves with an image
 *   fail    - every call rejects with an API-like error
 *   manual  - calls stay pending until resolveNext()/rejectNext()
 */
export function createFakeOpenAI({ mode = 'success', honourAbort = true } = {}) {
  const calls = [];
  const pending = [];
  let currentMode = mode;

  function makeError() {
    const error = new Error('Upstream failure: internal detail sk-should-not-leak');
    error.status = 500;
    return error;
  }

  const handler = (kind) => (params, options = {}) => {
    calls.push({ kind, params, options });
    if (currentMode === 'success') return Promise.resolve({ data: [{ b64_json: FAKE_PNG_BASE64 }] });
    if (currentMode === 'fail') return Promise.reject(makeError());
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => resolve({ data: [{ b64_json: FAKE_PNG_BASE64 }] }),
        reject: (error = makeError()) => reject(error),
      };
      pending.push(entry);
      if (honourAbort && options.signal) {
        options.signal.addEventListener('abort', () => reject(new Error('Request was aborted.')), { once: true });
      }
    });
  };

  return {
    images: { generate: handler('generate'), edit: handler('edit') },
    calls,
    setMode(next) {
      currentMode = next;
    },
    resolveNext() {
      const entry = pending.shift();
      if (!entry) throw new Error('No pending OpenAI call');
      entry.resolve();
    },
    rejectNext(error) {
      const entry = pending.shift();
      if (!entry) throw new Error('No pending OpenAI call');
      entry.reject(error);
    },
    pendingCount: () => pending.length,
  };
}

export async function startServer({ db, openai, clock = createClock(), config = {}, workerId } = {}) {
  const fullConfig = buildTestConfig({
    authRateLimitPerHour: 10_000,
    startRateLimitPer10Min: 10_000,
    readRateLimitPer5Min: 100_000,
    ipRateLimitPer5Min: 100_000,
    ...config,
  });
  const { app, service } = createApp({ db, openai, config: fullConfig, clock, logger: silentLogger, workerId });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    service,
    clock,
    api: createClient(baseUrl),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function createClient(baseUrl) {
  async function request(method, urlPath, { body, rawBody, token, headers = {} } = {}) {
    const finalHeaders = { ...headers };
    if (body !== undefined || rawBody !== undefined) finalHeaders['content-type'] = 'application/json';
    if (token) finalHeaders.authorization = `Bearer ${token}`;
    const response = await fetch(baseUrl + urlPath, {
      method,
      headers: finalHeaders,
      body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, body: json, headers: response.headers, text };
  }

  return {
    request,
    get: (urlPath, options) => request('GET', urlPath, options),
    post: (urlPath, options) => request('POST', urlPath, options),
    async issueAccount() {
      const response = await request('POST', '/auth/anonymous');
      if (response.status !== 201) throw new Error(`Account issuance failed: ${response.status}`);
      return response.body;
    },
    startGeneration(token, { key = `key-${randomBytes(8).toString('hex')}`, body = { prompt: 'a white oak cabinet' } } = {}) {
      return request('POST', '/generation/start', { token, body, headers: { 'idempotency-key': key } });
    },
    usage(token) {
      return request('GET', '/usage', { token });
    },
  };
}

export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Opens a database and server for one test and registers cleanup.
 */
export async function setup(t, options = {}) {
  const handle = await createTestDatabase();
  const db = await handle.open();
  const openai = options.openai ?? createFakeOpenAI(options.openaiOptions);
  const server = await startServer({ db, openai, ...options.server });

  t.after(async () => {
    await server.close();
    await server.service.interruptAll().catch(() => {});
    await db.close().catch(() => {});
    await handle.destroy();
  });

  return { handle, db, openai, server, api: server.api, service: server.service, clock: server.clock };
}

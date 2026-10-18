import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import pg from 'pg';
import { ConfigError, loadConfig } from '../lib/config.js';
import { isLoopbackDatabaseUrl, validateDatabaseTarget } from '../lib/databaseTarget.js';
import { createPostgresDatabase } from '../lib/db.js';
import { runMigrations } from '../lib/migrate.js';
import { createFakeOpenAI, setup, silentLogger, startServer, usingRealPostgres } from './helpers.js';

const REF = 'abcdefghijklmnopqrst';
const OTHER_REF = 'tsrqponmlkjihgfedcba';
const POOLER = 'aws-0-eu-west-1.pooler.supabase.com';

// pg reads sslrootcert while parsing; the content is never used for a handshake here.
const caDir = mkdtempSync(path.join(os.tmpdir(), 'mainsches-ca-'));
const CA_FILE = path.join(caDir, 'supabase-ca.crt');
writeFileSync(CA_FILE, '-----BEGIN CERTIFICATE-----\nTUFJTlNDSEVTLVRFU1Q=\n-----END CERTIFICATE-----\n');
after(() => rmSync(caDir, { recursive: true, force: true }));

const SECURE_QUERY = `sslmode=verify-full&sslrootcert=${encodeURIComponent(CA_FILE)}`;
const poolerUrl = ({ ref = REF, user = `postgres.${ref}`, host = POOLER, port = 5432, database = 'postgres', query = SECURE_QUERY } = {}) =>
  `postgresql://${user}:secretpw@${host}:${port}/${database}${query ? `?${query}` : ''}`;
const check = (url, options = {}) => validateDatabaseTarget(url, { supabaseProjectRef: REF, env: {}, ...options });

const SUPABASE_PARAMS = 'DATABASE_URL for Supabase may only set sslmode=verify-full and sslrootcert.';
const VERIFIED_TLS = 'DATABASE_URL for Supabase must verify the server certificate against the CA file in sslrootcert.';

test('the configured Supabase session pooler URL is accepted and pg verifies its certificate', () => {
  assert.deepEqual(check(poolerUrl()), []);

  const { connectionParameters: effective } = new pg.Client({ connectionString: poolerUrl() });
  assert.equal(effective.host, POOLER);
  assert.equal(effective.port, 5432);
  assert.equal(effective.user, `postgres.${REF}`);
  assert.equal(effective.database, 'postgres');
  assert.equal(typeof effective.ssl, 'object');
  assert.notEqual(effective.ssl.rejectUnauthorized, false);
  assert.equal(effective.ssl.checkServerIdentity, undefined);
  assert.match(effective.ssl.ca, /BEGIN CERTIFICATE/);
});

test('repeated or encoded TLS parameters that pg would downgrade are rejected', () => {
  const downgrades = [
    `${SECURE_QUERY}&sslmode=disable`,
    `${SECURE_QUERY}&ssl%6Dode=disable`,
    `${SECURE_QUERY}&SSLMODE=disable`,
    `sslmode=disable&${SECURE_QUERY}`,
    `${SECURE_QUERY}&sslrootcert=${encodeURIComponent(CA_FILE)}`,
  ];
  for (const query of downgrades) {
    const url = poolerUrl({ query });
    assert.deepEqual(check(url), ['DATABASE_URL must not repeat query parameters.'], query);
  }

  // The first case is the reported bypass: pg itself ends up without TLS.
  assert.equal(new pg.Client({ connectionString: poolerUrl({ query: `${SECURE_QUERY}&sslmode=disable` }) }).connectionParameters.ssl, false);
});

test('insecure TLS settings and configuration bypasses are rejected', () => {
  const ca = `sslrootcert=${encodeURIComponent(CA_FILE)}`;
  for (const query of ['', 'sslmode=verify-full', `sslmode=require&${ca}`, `sslmode=no-verify&${ca}`, `sslmode=disable&${ca}`, `sslmode=prefer&${ca}`]) {
    assert.ok(check(poolerUrl({ query })).some((problem) => problem === SUPABASE_PARAMS || problem === VERIFIED_TLS), query);
  }
  for (const extra of ['uselibpqcompat=true', 'ssl=0', 'ssl=false', 'sslcert=x', 'sslnegotiation=direct', 'application_name=x']) {
    assert.ok(check(poolerUrl({ query: `${SECURE_QUERY}&${extra}` })).length > 0, extra);
  }
  assert.deepEqual(check(poolerUrl({ query: 'sslmode=verify-full' })), [VERIFIED_TLS]);
  assert.deepEqual(check(poolerUrl({ query: `sslmode=verify-full&sslrootcert=${encodeURIComponent(path.join(caDir, 'missing.crt'))}` })), [
    'DATABASE_URL could not be parsed by the database driver, or its sslrootcert file is unreadable.',
  ]);
  assert.deepEqual(check(poolerUrl(), { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } }), [
    'NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate verification and is not allowed with Supabase.',
  ]);
});

test('host, port, user and database are bound to the configured project', () => {
  assert.deepEqual(check(poolerUrl({ ref: OTHER_REF })), [
    'DATABASE_URL must connect as the postgres role of the project in SUPABASE_PROJECT_REF.',
  ]);
  assert.deepEqual(check(poolerUrl({ user: `authenticator.${REF}` })), [
    'DATABASE_URL must connect as the postgres role of the project in SUPABASE_PROJECT_REF.',
  ]);
  assert.deepEqual(check(poolerUrl({ database: 'other' })), ['DATABASE_URL must use the database postgres.']);
  assert.deepEqual(check(poolerUrl({ port: 6543 })), [
    'DATABASE_URL must use the Supabase session pooler on port 5432; transaction mode is not supported.',
  ]);
  assert.deepEqual(check(poolerUrl({ host: `db.${REF}.supabase.co` })), ['DATABASE_URL must use the Supabase session pooler host.']);
  assert.deepEqual(check(poolerUrl({ host: 'evil.pooler.supabase.com.example' })), [
    'SUPABASE_PROJECT_REF is set but DATABASE_URL does not point to a Supabase database.',
  ]);
  assert.deepEqual(check(poolerUrl(), { supabaseProjectRef: '' }), [
    'SUPABASE_PROJECT_REF is required when DATABASE_URL points to Supabase.',
  ]);
  assert.deepEqual(check('postgres://u:p@localhost:5432/db'), [
    'SUPABASE_PROJECT_REF is set but DATABASE_URL does not point to a Supabase database.',
  ]);
  assert.deepEqual(check('postgres://u:p@localhost:5432/db', { supabaseProjectRef: 'short' }), [
    'SUPABASE_PROJECT_REF must be a 20-character Supabase project reference.',
    'SUPABASE_PROJECT_REF is set but DATABASE_URL does not point to a Supabase database.',
  ]);
});

test('query parameters cannot redirect the connection', () => {
  const overrides = 'DATABASE_URL must not override host, port, user, database or options through query parameters.';
  const redirected = `postgres://u:p@localhost:5432/db?host=${POOLER}`;
  assert.deepEqual(validateDatabaseTarget(redirected, { env: {} }), [overrides]);
  for (const param of ['host', 'HOST', 'h%6Fst', 'hostaddr', 'port', 'user', 'database', 'dbname', 'options']) {
    assert.deepEqual(check(poolerUrl({ query: `${SECURE_QUERY}&${param}=x` })), [overrides], param);
  }
  assert.equal(isLoopbackDatabaseUrl(redirected), false);
  assert.equal(isLoopbackDatabaseUrl('postgres://u:p@localhost/db?sslmode=disable&sslmode=disable'), false);
});

test('only loopback URLs qualify as test databases', () => {
  assert.equal(isLoopbackDatabaseUrl('postgresql://u:p@127.0.0.1:55432/db'), true);
  assert.equal(isLoopbackDatabaseUrl('postgresql://u:p@localhost/db'), true);
  assert.equal(isLoopbackDatabaseUrl('postgresql://u:p@[::1]:5432/db'), true);
  assert.equal(isLoopbackDatabaseUrl(poolerUrl()), false);
  assert.equal(isLoopbackDatabaseUrl('postgresql://u:p@db.internal:5432/db'), false);
  assert.equal(isLoopbackDatabaseUrl('not a url'), false);
});

test('configuration rejects a foreign Supabase project without echoing the URL', () => {
  const env = { OPENAI_API_KEY: 'sk-test', SUPABASE_PROJECT_REF: REF };
  assert.throws(
    () => loadConfig({ ...env, DATABASE_URL: poolerUrl({ ref: OTHER_REF }) }),
    (error) =>
      error instanceof ConfigError &&
      error.problems.includes('DATABASE_URL must connect as the postgres role of the project in SUPABASE_PROJECT_REF.') &&
      !error.message.includes('secretpw') &&
      !error.message.includes(OTHER_REF) &&
      !error.message.includes(POOLER) &&
      !error.message.includes(CA_FILE)
  );
  assert.throws(() => loadConfig({ OPENAI_API_KEY: 'sk-test', DATABASE_URL: poolerUrl() }), ConfigError);
  assert.throws(() => loadConfig({ ...env, DATABASE_URL: poolerUrl(), NODE_TLS_REJECT_UNAUTHORIZED: '0' }), ConfigError);

  const config = loadConfig({ ...env, DATABASE_URL: poolerUrl(), DATABASE_POOL_MAX: '5' });
  assert.equal(config.supabaseProjectRef, REF);
  assert.equal(config.databasePoolMax, 5);
  assert.equal(config.databaseStatementTimeoutMs, 30_000);
  assert.equal(config.healthCheckTimeoutMs, 5_000);
  assert.throws(() => loadConfig({ ...env, DATABASE_URL: poolerUrl(), DATABASE_STATEMENT_TIMEOUT_MS: '0' }), ConfigError);
});

test('row level security is enabled on every backend table', async (t) => {
  const { db } = await setup(t);
  const { rows } = await db.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind = 'r'
      ORDER BY c.relname`
  );
  assert.deepEqual(
    rows.map((row) => [row.relname, row.relrowsecurity, row.relforcerowsecurity]),
    [
      ['auth_tokens', true, false],
      ['daily_usage', true, false],
      ['generations', true, false],
      ['schema_migrations', true, false],
      ['users', true, false],
    ]
  );
});

test('health check answers 503 when the database does not respond in time', async (t) => {
  const { db } = await setup(t);
  const stalledDb = {
    ...db,
    query: (text, params) => (text === 'SELECT 1' ? new Promise(() => {}) : db.query(text, params)),
  };
  const server = await startServer({ db: stalledDb, openai: createFakeOpenAI(), config: { healthCheckTimeoutMs: 200 } });
  t.after(() => server.close());

  const startedAt = Date.now();
  const health = await server.api.get('/health');
  assert.equal(health.status, 503);
  assert.equal(health.body.code, 'UNHEALTHY');
  assert.ok(Date.now() - startedAt < 2_000);
});

test('pooled sessions enforce statement and idle-in-transaction timeouts', { skip: !usingRealPostgres && 'needs TEST_DATABASE_URL' }, async () => {
  const db = createPostgresDatabase({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 2,
    statementTimeoutMs: 1_000,
    idleInTransactionTimeoutMs: 7_000,
    logger: silentLogger,
  });
  try {
    const settings = await db.query(
      `SELECT current_setting('statement_timeout') AS statement_timeout,
              current_setting('idle_in_transaction_session_timeout') AS idle_timeout`
    );
    assert.deepEqual(
      { statement: settings.rows[0].statement_timeout, idle: settings.rows[0].idle_timeout },
      { statement: '1s', idle: '7s' }
    );

    await assert.rejects(db.query('SELECT pg_sleep(3)'), (error) => error.code === '57014');
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [727_114_999]);
        await tx.query('SELECT pg_sleep(3)');
      }),
      (error) => error.code === '57014'
    );

    // The advisory lock is transaction-scoped: no session still holds it after the rollback.
    const held = await db.query(
      `SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND objsubid = 1`,
      [727_114_999]
    );
    assert.equal(held.rows[0].count, 0);
  } finally {
    await db.close();
  }
});

const API_ROLES = ['anon', 'authenticated', 'service_role'];
const BACKEND_TABLES = ['users', 'auth_tokens', 'daily_usage', 'generations', 'schema_migrations'];

test('Data API roles, including service_role, lose access to existing and future objects', { skip: !usingRealPostgres && 'needs TEST_DATABASE_URL' }, async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = createPostgresDatabase({ connectionString, max: 1, logger: silentLogger });
  const existing = await admin.query(`SELECT rolname FROM pg_roles WHERE rolname = ANY($1)`, [API_ROLES]);
  const createdRoles = API_ROLES.filter((role) => !existing.rows.some((row) => row.rolname === role));
  for (const role of createdRoles) {
    await admin.exec(`CREATE ROLE ${role} NOLOGIN${role === 'service_role' ? ' BYPASSRLS' : ''}`);
  }

  // Mirrors Supabase: the API roles may use the schema, and objects created by
  // the owner are granted to them through schema-level default privileges.
  const roles = API_ROLES.join(', ');
  await admin.exec(`CREATE SCHEMA ${schema}`);
  await admin.exec(`GRANT USAGE ON SCHEMA ${schema} TO ${roles}`);
  for (const kind of ['TABLES', 'SEQUENCES', 'FUNCTIONS']) {
    await admin.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON ${kind} TO ${roles}`);
  }

  const db = createPostgresDatabase({ connectionString, max: 1, options: `-c search_path=${schema}`, logger: silentLogger });
  try {
    await runMigrations(db, { logger: silentLogger });
    assert.deepEqual(await runMigrations(db, { logger: silentLogger }), [], 'migrations run exactly once');
    await db.query(`INSERT INTO users (id, created_at, updated_at) VALUES ($1, now(), now())`, [
      `usr_${randomBytes(16).toString('hex')}`,
    ]);

    const privileges = await db.query(
      `SELECT r.role, t.name,
              has_table_privilege(r.role, t.name, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS granted
         FROM unnest($1::text[]) AS r(role), unnest($2::text[]) AS t(name)`,
      [API_ROLES, BACKEND_TABLES]
    );
    assert.deepEqual(privileges.rows.filter((row) => row.granted), []);

    for (const role of API_ROLES) {
      await db.transaction(async (tx) => {
        await tx.exec(`SET LOCAL ROLE ${role}`);
        await assert.rejects(tx.query('SELECT * FROM auth_tokens'), (error) => error.code === '42501', role);
      });
    }

    // Objects created later by the owner inherit no grants for the API roles or PUBLIC.
    await db.exec('CREATE TABLE later_table (id INTEGER)');
    await db.exec('CREATE SEQUENCE later_sequence');
    await db.exec('CREATE FUNCTION later_function() RETURNS INTEGER LANGUAGE sql AS $$ SELECT 1 $$');
    const future = await db.query(
      `SELECT r.role,
              has_table_privilege(r.role, 'later_table', 'SELECT, INSERT, UPDATE, DELETE') AS table_granted,
              has_sequence_privilege(r.role, 'later_sequence', 'USAGE, SELECT, UPDATE') AS sequence_granted,
              has_function_privilege(r.role, 'later_function()', 'EXECUTE') AS function_granted
         FROM unnest($1::text[]) AS r(role)`,
      [API_ROLES]
    );
    assert.deepEqual(future.rows.filter((row) => row.table_granted || row.sequence_granted || row.function_granted), []);
    const publicAcl = await db.query(`SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'later_function'`);
    assert.doesNotMatch(publicAcl.rows[0].acl, /(^|[{,])=X/, 'PUBLIC has no EXECUTE on new functions');

    // A grant restored by mistake still exposes no rows to RLS-bound roles;
    // service_role bypasses RLS, which is why its grants are revoked above.
    await db.exec('GRANT SELECT ON users TO anon, service_role');
    const visible = async (role) =>
      db.transaction(async (tx) => {
        await tx.exec(`SET LOCAL ROLE ${role}`);
        return (await tx.query('SELECT count(*)::int AS count FROM users')).rows[0].count;
      });
    assert.equal(await visible('anon'), 0);
    assert.equal(await visible('service_role'), 1);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM users')).rows[0].count, 1);
  } finally {
    await db.close();
    await admin.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const role of createdRoles) {
      await admin.exec(`DROP OWNED BY ${role}`);
      await admin.exec(`DROP ROLE ${role}`);
    }
    await admin.close();
  }
});

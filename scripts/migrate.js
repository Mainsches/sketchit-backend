import dotenv from 'dotenv';
import { DEFAULT_CONFIG } from '../lib/config.js';
import { validateDatabaseTarget } from '../lib/databaseTarget.js';
import { createPostgresDatabase } from '../lib/db.js';
import { runMigrations } from '../lib/migrate.js';

dotenv.config();

const databaseUrl = String(process.env.DATABASE_URL ?? '').trim();
if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
  console.error('DATABASE_URL must be set to a postgres:// or postgresql:// connection string.');
  process.exit(1);
}

const targetProblems = validateDatabaseTarget(databaseUrl, { supabaseProjectRef: process.env.SUPABASE_PROJECT_REF });
if (targetProblems.length) {
  console.error(`Refusing to migrate:\n- ${targetProblems.join('\n- ')}`);
  process.exit(1);
}

const requestedTimeoutMs = Number.parseInt(String(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? ''), 10);
const statementTimeoutMs =
  requestedTimeoutMs >= 1_000 && requestedTimeoutMs <= 600_000 ? requestedTimeoutMs : DEFAULT_CONFIG.databaseStatementTimeoutMs;

const db = createPostgresDatabase({ connectionString: databaseUrl, max: 1, statementTimeoutMs });
try {
  const applied = await runMigrations(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
} catch (error) {
  console.error('Migration failed:', error?.code || '', error?.message || error);
  process.exitCode = 1;
} finally {
  await db.close();
}

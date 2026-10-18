import dotenv from 'dotenv';
import { createPostgresDatabase } from '../lib/db.js';
import { runMigrations } from '../lib/migrate.js';

dotenv.config();

const databaseUrl = String(process.env.DATABASE_URL ?? '').trim();
if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
  console.error('DATABASE_URL must be set to a postgres:// or postgresql:// connection string.');
  process.exit(1);
}

const db = createPostgresDatabase({ connectionString: databaseUrl, max: 1 });
try {
  const applied = await runMigrations(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
} catch (error) {
  console.error('Migration failed:', error?.message || error);
  process.exitCode = 1;
} finally {
  await db.close();
}

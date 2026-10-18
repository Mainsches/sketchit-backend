import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MIGRATION_LOCK_ID = 727_114_001;

export async function loadMigrations(dir = MIGRATIONS_DIR) {
  const files = (await readdir(dir)).filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).sort();
  const migrations = [];
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    migrations.push({
      version: file.replace(/\.sql$/, ''),
      sql,
      checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'),
    });
  }
  return migrations;
}

/**
 * Applies pending migrations in order. All migrations run in one transaction
 * guarded by an advisory lock, so concurrent instances cannot apply them twice.
 */
export async function runMigrations(db, { logger = console, dir } = {}) {
  const migrations = await loadMigrations(dir);

  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await tx.query('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((row) => [row.version, row.checksum]));
    const known = new Set(migrations.map((migration) => migration.version));

    for (const version of applied.keys()) {
      if (!known.has(version)) {
        throw new Error(`Database has migration ${version} that is not present in this build.`);
      }
    }

    const newlyApplied = [];
    for (const migration of migrations) {
      const existingChecksum = applied.get(migration.version);
      if (existingChecksum) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(`Migration ${migration.version} was modified after it was applied.`);
        }
        continue;
      }
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
        migration.version,
        migration.checksum,
      ]);
      newlyApplied.push(migration.version);
      logger.info?.(`[migrate] applied ${migration.version}`);
    }

    return newlyApplied;
  });
}

import pg from 'pg';

const DATE_OID = 1082;

// DATE columns are returned as 'YYYY-MM-DD' strings; the default pg parser
// converts them to local-time Date objects, which shifts UTC day keys.
const pgTypes = {
  getTypeParser(oid, format) {
    if (oid === DATE_OID) return (value) => value;
    return pg.types.getTypeParser(oid, format);
  },
};

function wrapPgClient(client) {
  return {
    async query(text, params = []) {
      const result = await client.query(text, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    async exec(sql) {
      await client.query(sql);
    },
  };
}

/**
 * Database interface used by the application:
 *   query(text, params) -> { rows, rowCount }
 *   exec(sql)           -> runs one or more statements without parameters
 *   transaction(fn)     -> runs fn(tx) inside BEGIN/COMMIT, rolling back on error
 *   close()
 */
export function createPostgresDatabase({ connectionString, max = 10, options, logger = console }) {
  const pool = new pg.Pool({
    connectionString,
    max,
    options,
    types: pgTypes,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (error) => {
    logger.error('[db] idle client error', error?.code || error?.message);
  });

  return {
    dialect: 'postgres',
    async query(text, params = []) {
      const result = await pool.query(text, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      let discardClient = false;
      try {
        await client.query('BEGIN');
        const result = await fn(wrapPgClient(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discardClient = true;
        }
        throw error;
      } finally {
        client.release(discardClient);
      }
    },
    async close() {
      await pool.end();
    },
  };
}

export function isUniqueViolation(error, constraint) {
  return error?.code === '23505' && (!constraint || error?.constraint === constraint);
}

import pg from 'pg';

const SUPABASE_HOST = /\.supabase\.(co|com)$/i;
const SUPABASE_SESSION_POOLER_HOST = /^aws-\d+-[a-z]{2}-[a-z]+-\d+\.pooler\.supabase\.com$/;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const SESSION_POOLER_PORT = 5432;
const SUPABASE_DATABASE = 'postgres';
const SUPABASE_ROLE = 'postgres';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
// pg lets these query parameters replace the host, port, user, database or
// session options of the URL.
const TARGET_OVERRIDE_PARAMS = new Set(['host', 'hostaddr', 'port', 'user', 'database', 'dbname', 'options']);
const SUPABASE_ALLOWED_PARAMS = new Set(['sslmode', 'sslrootcert']);

function parseUrl(databaseUrl) {
  try {
    return new URL(databaseUrl);
  } catch {
    return null;
  }
}

/**
 * Query parameter names as pg sees them (percent-decoded). Returns null when a
 * name occurs more than once, because pg silently keeps the last value.
 */
function uniqueParamNames(url) {
  const names = [...url.searchParams.keys()].map((name) => name.toLowerCase());
  return new Set(names).size === names.length ? new Set(names) : null;
}

/**
 * Builds a pg.Client without connecting and returns the parameters pg will
 * actually use. Throws if pg cannot parse the URL or read sslrootcert.
 */
function effectiveConnectionParameters(databaseUrl) {
  const { connectionParameters } = new pg.Client({ connectionString: databaseUrl });
  return connectionParameters;
}

function normaliseHost(host) {
  return String(host ?? '').toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function hasVerifiedTls(ssl) {
  return (
    Boolean(ssl) &&
    typeof ssl === 'object' &&
    ssl.rejectUnauthorized !== false &&
    ssl.checkServerIdentity === undefined &&
    typeof ssl.ca === 'string' &&
    ssl.ca.includes('-----BEGIN CERTIFICATE-----')
  );
}

/**
 * Checks that DATABASE_URL targets the intended database. A Supabase URL is
 * only accepted for the session pooler of the project named in
 * SUPABASE_PROJECT_REF, as role postgres on database postgres, with certificate
 * and host name verification against the CA file given in sslrootcert. The
 * decision is based on the parameters pg itself derives from the URL. Problems
 * never contain parts of the URL.
 */
export function validateDatabaseTarget(databaseUrl, { supabaseProjectRef = '', env = process.env } = {}) {
  const problems = [];
  const url = parseUrl(databaseUrl);
  if (!url || !url.hostname) {
    return ['DATABASE_URL could not be parsed or has no host.'];
  }

  const paramNames = uniqueParamNames(url);
  if (!paramNames) {
    return ['DATABASE_URL must not repeat query parameters.'];
  }
  if ([...paramNames].some((name) => TARGET_OVERRIDE_PARAMS.has(name))) {
    return ['DATABASE_URL must not override host, port, user, database or options through query parameters.'];
  }

  let effective;
  try {
    effective = effectiveConnectionParameters(databaseUrl);
  } catch {
    return ['DATABASE_URL could not be parsed by the database driver, or its sslrootcert file is unreadable.'];
  }
  if (normaliseHost(effective.host) !== normaliseHost(url.hostname)) {
    return ['DATABASE_URL resolves to a different host than it names.'];
  }

  const expectedRef = String(supabaseProjectRef ?? '').trim().toLowerCase();
  if (expectedRef && !PROJECT_REF_PATTERN.test(expectedRef)) {
    problems.push('SUPABASE_PROJECT_REF must be a 20-character Supabase project reference.');
  }

  const host = normaliseHost(effective.host);
  if (!SUPABASE_HOST.test(host)) {
    if (expectedRef) {
      problems.push('SUPABASE_PROJECT_REF is set but DATABASE_URL does not point to a Supabase database.');
    }
    return problems;
  }

  if (!expectedRef) {
    problems.push('SUPABASE_PROJECT_REF is required when DATABASE_URL points to Supabase.');
  }
  if (!SUPABASE_SESSION_POOLER_HOST.test(host)) {
    problems.push('DATABASE_URL must use the Supabase session pooler host.');
  }
  if (effective.port !== SESSION_POOLER_PORT) {
    problems.push('DATABASE_URL must use the Supabase session pooler on port 5432; transaction mode is not supported.');
  }
  if (expectedRef && PROJECT_REF_PATTERN.test(expectedRef) && effective.user !== `${SUPABASE_ROLE}.${expectedRef}`) {
    problems.push('DATABASE_URL must connect as the postgres role of the project in SUPABASE_PROJECT_REF.');
  }
  if (effective.database !== SUPABASE_DATABASE) {
    problems.push('DATABASE_URL must use the database postgres.');
  }
  if ([...paramNames].some((name) => !SUPABASE_ALLOWED_PARAMS.has(name)) || url.searchParams.get('sslmode') !== 'verify-full') {
    problems.push('DATABASE_URL for Supabase may only set sslmode=verify-full and sslrootcert.');
  }
  if (!hasVerifiedTls(effective.ssl)) {
    problems.push('DATABASE_URL for Supabase must verify the server certificate against the CA file in sslrootcert.');
  }
  if (String(env.NODE_TLS_REJECT_UNAUTHORIZED ?? '').trim() === '0') {
    problems.push('NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate verification and is not allowed with Supabase.');
  }

  return problems;
}

export function isLoopbackDatabaseUrl(databaseUrl) {
  const url = parseUrl(databaseUrl);
  if (!url) return false;
  const paramNames = uniqueParamNames(url);
  if (!paramNames || [...paramNames].some((name) => TARGET_OVERRIDE_PARAMS.has(name))) return false;
  const host = normaliseHost(url.hostname);
  return LOOPBACK_HOSTS.has(host) || /^127(\.\d{1,3}){3}$/.test(host);
}

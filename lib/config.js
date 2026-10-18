import { validateDatabaseTarget } from './databaseTarget.js';

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export const DEFAULT_CONFIG = Object.freeze({
  port: 3000,
  nodeEnv: 'development',
  trustProxy: false,
  corsOrigins: [],
  jsonBodyLimitBytes: 25 * 1024 * 1024,
  maxSketchBytes: 16 * 1024 * 1024,
  maxPromptChars: 4000,
  migrateOnStart: true,
  databasePoolMax: 10,
  databaseStatementTimeoutMs: 30_000,
  healthCheckTimeoutMs: 5_000,
  openaiTimeoutMs: 180_000,
  jobTimeoutMs: 300_000,
  jobLeaseMs: 90_000,
  imageRetentionHours: 24,
  recordRetentionDays: 30,
  usageRetentionDays: 90,
  authRateLimitPerHour: 20,
  startRateLimitPer10Min: 30,
  readRateLimitPer5Min: 600,
  ipRateLimitPer5Min: 1200,
});

function parseInteger(env, name, fallback, { min, max }, problems) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw).trim())) {
    problems.push(`${name} must be an integer.`);
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    problems.push(`${name} must be between ${min} and ${max}.`);
    return fallback;
  }
  return value;
}

function parseBoolean(env, name, fallback, problems) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(value)) return true;
  if (['0', 'false', 'no'].includes(value)) return false;
  problems.push(`${name} must be true or false.`);
  return fallback;
}

function parseTrustProxy(raw, problems) {
  const value = String(raw).trim().toLowerCase();
  if (value === 'false' || value === '0') return false;
  if (value === 'true') {
    problems.push('TRUST_PROXY=true trusts every hop and allows client IP spoofing; use a hop count such as 1.');
    return false;
  }
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  problems.push('TRUST_PROXY must be false or a hop count (for example 1).');
  return false;
}

export function loadConfig(env = process.env) {
  const problems = [];
  const nodeEnv = String(env.NODE_ENV || DEFAULT_CONFIG.nodeEnv).trim();
  const isProduction = nodeEnv === 'production';

  const openaiApiKey = String(env.OPENAI_API_KEY ?? '').trim();
  if (!openaiApiKey) {
    problems.push('OPENAI_API_KEY is required.');
  }

  const databaseUrl = String(env.DATABASE_URL ?? '').trim();
  const supabaseProjectRef = String(env.SUPABASE_PROJECT_REF ?? '').trim().toLowerCase();
  if (!databaseUrl) {
    problems.push('DATABASE_URL is required.');
  } else if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    problems.push('DATABASE_URL must be a postgres:// or postgresql:// connection string.');
  } else {
    problems.push(...validateDatabaseTarget(databaseUrl, { supabaseProjectRef, env }));
  }

  let trustProxy = DEFAULT_CONFIG.trustProxy;
  if (env.TRUST_PROXY === undefined || env.TRUST_PROXY === '') {
    if (isProduction) {
      problems.push('TRUST_PROXY is required in production (hop count of the hosting proxy, or false).');
    }
  } else {
    trustProxy = parseTrustProxy(env.TRUST_PROXY, problems);
  }

  const corsOrigins = String(env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of corsOrigins) {
    if (origin === '*' || !/^https?:\/\/[^/\s]+$/i.test(origin)) {
      problems.push('CORS_ORIGINS must be a comma-separated list of explicit http(s) origins.');
      break;
    }
  }

  const config = {
    nodeEnv,
    isProduction,
    openaiApiKey,
    databaseUrl,
    supabaseProjectRef,
    trustProxy,
    corsOrigins,
    port: parseInteger(env, 'PORT', DEFAULT_CONFIG.port, { min: 1, max: 65535 }, problems),
    jsonBodyLimitBytes: parseInteger(env, 'JSON_BODY_LIMIT_BYTES', DEFAULT_CONFIG.jsonBodyLimitBytes, { min: 1024, max: 50 * 1024 * 1024 }, problems),
    maxSketchBytes: parseInteger(env, 'MAX_SKETCH_BYTES', DEFAULT_CONFIG.maxSketchBytes, { min: 1024, max: 40 * 1024 * 1024 }, problems),
    maxPromptChars: parseInteger(env, 'MAX_PROMPT_CHARS', DEFAULT_CONFIG.maxPromptChars, { min: 100, max: 20000 }, problems),
    migrateOnStart: parseBoolean(env, 'MIGRATE_ON_START', DEFAULT_CONFIG.migrateOnStart, problems),
    databasePoolMax: parseInteger(env, 'DATABASE_POOL_MAX', DEFAULT_CONFIG.databasePoolMax, { min: 1, max: 100 }, problems),
    databaseStatementTimeoutMs: parseInteger(env, 'DATABASE_STATEMENT_TIMEOUT_MS', DEFAULT_CONFIG.databaseStatementTimeoutMs, { min: 1_000, max: 600_000 }, problems),
    healthCheckTimeoutMs: parseInteger(env, 'HEALTH_CHECK_TIMEOUT_MS', DEFAULT_CONFIG.healthCheckTimeoutMs, { min: 500, max: 60_000 }, problems),
    openaiTimeoutMs: parseInteger(env, 'OPENAI_TIMEOUT_MS', DEFAULT_CONFIG.openaiTimeoutMs, { min: 10_000, max: 600_000 }, problems),
    jobTimeoutMs: parseInteger(env, 'JOB_TIMEOUT_MS', DEFAULT_CONFIG.jobTimeoutMs, { min: 10_000, max: 1_800_000 }, problems),
    jobLeaseMs: parseInteger(env, 'JOB_LEASE_MS', DEFAULT_CONFIG.jobLeaseMs, { min: 15_000, max: 600_000 }, problems),
    imageRetentionHours: parseInteger(env, 'IMAGE_RETENTION_HOURS', DEFAULT_CONFIG.imageRetentionHours, { min: 1, max: 24 * 30 }, problems),
    recordRetentionDays: parseInteger(env, 'RECORD_RETENTION_DAYS', DEFAULT_CONFIG.recordRetentionDays, { min: 2, max: 365 }, problems),
    usageRetentionDays: parseInteger(env, 'USAGE_RETENTION_DAYS', DEFAULT_CONFIG.usageRetentionDays, { min: 2, max: 3650 }, problems),
    authRateLimitPerHour: parseInteger(env, 'AUTH_RATE_LIMIT_PER_HOUR', DEFAULT_CONFIG.authRateLimitPerHour, { min: 1, max: 10_000 }, problems),
    startRateLimitPer10Min: parseInteger(env, 'START_RATE_LIMIT_PER_10_MIN', DEFAULT_CONFIG.startRateLimitPer10Min, { min: 1, max: 10_000 }, problems),
    readRateLimitPer5Min: parseInteger(env, 'READ_RATE_LIMIT_PER_5_MIN', DEFAULT_CONFIG.readRateLimitPer5Min, { min: 1, max: 100_000 }, problems),
    ipRateLimitPer5Min: parseInteger(env, 'IP_RATE_LIMIT_PER_5_MIN', DEFAULT_CONFIG.ipRateLimitPer5Min, { min: 1, max: 100_000 }, problems),
  };

  if (config.jobTimeoutMs < config.openaiTimeoutMs) {
    problems.push('JOB_TIMEOUT_MS must be greater than or equal to OPENAI_TIMEOUT_MS.');
  }

  if (problems.length) {
    throw new ConfigError(problems);
  }

  return Object.freeze(config);
}

export function buildTestConfig(overrides = {}) {
  return Object.freeze({
    ...DEFAULT_CONFIG,
    nodeEnv: 'test',
    isProduction: false,
    openaiApiKey: 'test-key-not-used',
    databaseUrl: 'postgres://test',
    ...overrides,
  });
}

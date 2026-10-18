import dotenv from 'dotenv';
import OpenAI from 'openai';
import { createApp } from './lib/app.js';
import { ConfigError, loadConfig } from './lib/config.js';
import { createPostgresDatabase } from './lib/db.js';
import { runMigrations } from './lib/migrate.js';

dotenv.config();

const RECOVERY_INTERVAL_MS = 30_000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 20_000;

function every(intervalMs, task, label) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (error) {
      console.error(`[maintenance] ${label} failed`, error?.code || error?.message);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const db = createPostgresDatabase({ connectionString: config.databaseUrl, max: config.databasePoolMax });

  if (config.migrateOnStart) {
    await runMigrations(db);
  }

  const openai = new OpenAI({ apiKey: config.openaiApiKey, timeout: config.openaiTimeoutMs, maxRetries: 1 });
  const { app, service } = createApp({ db, openai, config });

  await service.recoverInterruptedJobs();

  const timers = [
    every(Math.max(5_000, Math.floor(config.jobLeaseMs / 3)), () => service.renewLeases(), 'lease renewal'),
    every(RECOVERY_INTERVAL_MS, () => service.recoverInterruptedJobs(), 'job recovery'),
    every(RETENTION_INTERVAL_MS, () => service.cleanupRetention(), 'retention cleanup'),
  ];

  const server = app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, shutting down`);
    timers.forEach(clearInterval);
    server.close();

    const graceTimer = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
    await Promise.race([service.waitForIdle(), graceTimer]);
    if (service.activeJobCount()) {
      await service.interruptAll();
    }
    await db.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[server] failed to start', error?.code || '', error?.message || error);
  process.exit(1);
});

import { toFile } from 'openai/uploads';
import { createRandomId } from './auth.js';
import { isUniqueViolation } from './db.js';
import { buildGenerationMode, buildModePrompt } from './promptBuilder.js';
import { FREE_DAILY_LIMIT, getNextUtcMidnightIso, getUtcDayKey } from './usage.js';

const ACTIVE_STATUSES = "('pending', 'processing')";
const RETENTION_BATCH_SIZE = 200;
const RETENTION_MAX_BATCHES = 20;

const PUBLIC_FAILURES = {
  GENERATION_FAILED: 'Image generation failed. Your free image was not used.',
  GENERATION_TIMEOUT: 'Image generation timed out. Your free image was not used.',
  CONTENT_REJECTED: 'The request was rejected by the content safety system. Your free image was not used.',
  INTERRUPTED: 'Image generation was interrupted. Your free image was not used.',
};

class JobAbort extends Error {
  constructor(code) {
    super(code);
    this.name = 'JobAbort';
    this.failureCode = code;
  }
}

function getImageUrlFromResult(result) {
  const first = Array.isArray(result?.data) ? result.data[0] : null;
  if (first?.b64_json) return `data:image/png;base64,${first.b64_json}`;
  if (first?.url) return first.url;
  return null;
}

function classifyFailure(error, signal) {
  if (signal?.aborted && signal.reason instanceof JobAbort) {
    return signal.reason.failureCode;
  }
  const code = String(error?.code ?? error?.error?.code ?? '').toLowerCase();
  if (error?.status === 400 && (code.includes('moderation') || code.includes('content_policy') || code.includes('safety'))) {
    return 'CONTENT_REJECTED';
  }
  return 'GENERATION_FAILED';
}

function sketchFileName(mimeType) {
  if (mimeType === 'image/png') return 'sketch.png';
  if (mimeType === 'image/webp') return 'sketch.webp';
  return 'sketch.jpg';
}

export function createGenerationService({ db, openai, clock, config, logger = console, workerId = createRandomId('wrk') }) {
  const inFlight = new Map();

  async function lockUser(tx, userId) {
    const { rows } = await tx.query('SELECT id, total_completed FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
    return rows[0] ?? null;
  }

  async function findByIdempotencyKey(tx, userId, idempotencyKey) {
    const { rows } = await tx.query('SELECT * FROM generations WHERE user_id = $1 AND idempotency_key = $2', [
      userId,
      idempotencyKey,
    ]);
    return rows[0] ?? null;
  }

  function replayOutcome(row, requestHash) {
    if (row.request_hash !== requestHash) return { type: 'conflict', row };
    return { type: 'replay', row };
  }

  async function reserveFreeGeneration({ userId, idempotencyKey, request }) {
    const nowMs = clock.now();
    const now = new Date(nowMs);
    const quotaDay = getUtcDayKey(nowMs);

    return db.transaction(async (tx) => {
      // Serialises all starts of one user so the idempotency lookup and the
      // reservation observe each other's committed results. Every transaction
      // that touches daily_usage takes this lock first to keep a single lock order.
      const user = await lockUser(tx, userId);
      if (!user) throw new Error('Authenticated user no longer exists');

      if (idempotencyKey) {
        const existing = await findByIdempotencyKey(tx, userId, idempotencyKey);
        if (existing) return replayOutcome(existing, request.requestHash);
      }

      await tx.query(
        `INSERT INTO daily_usage (user_id, usage_day, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, usage_day) DO NOTHING`,
        [userId, quotaDay, now]
      );

      const reserved = await tx.query(
        `UPDATE daily_usage
            SET free_pending = free_pending + 1, updated_at = $3
          WHERE user_id = $1 AND usage_day = $2 AND free_consumed + free_pending < $4
          RETURNING free_consumed, free_pending`,
        [userId, quotaDay, now, FREE_DAILY_LIMIT]
      );
      if (reserved.rows.length !== 1) return { type: 'limit' };

      const { rows } = await tx.query(
        `INSERT INTO generations (
           id, user_id, idempotency_key, request_hash, client_session_id, kind, mode, generation_mode,
           funding_source, quota_day, status, prompt, mime_type, has_sketch, variation_index,
           worker_id, lease_expires_at, created_at, started_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'base', $6, $7,
           'free_daily', $8, 'pending', $9, $10, $11, 0,
           $12, $13, $14, $14, $14
         )
         RETURNING *`,
        [
          createRandomId('gen'),
          userId,
          idempotencyKey,
          request.requestHash,
          request.sessionLabel,
          request.mode,
          request.generationMode,
          quotaDay,
          request.prompt,
          request.mimeType,
          Boolean(request.sketch),
          workerId,
          new Date(nowMs + config.jobLeaseMs),
          now,
        ]
      );
      return {
        type: 'created',
        row: rows[0],
        usageAtStart: {
          userId,
          dayKey: quotaDay,
          resetsAt: getNextUtcMidnightIso(nowMs),
          consumed: Number(reserved.rows[0].free_consumed),
          pending: Number(reserved.rows[0].free_pending),
          totalCompleted: Number(user.total_completed),
        },
      };
    });
  }

  /**
   * Moves a running generation to a terminal state and settles its free
   * reservation against the generation's original quota day. The status guard
   * makes this a no-op for generations that were already finalised.
   */
  async function finalize(generationId, { success, imageUrl = null, failureCode = null }) {
    const nowMs = clock.now();
    const now = new Date(nowMs);

    return db.transaction(async (tx) => {
      const owner = await tx.query('SELECT user_id FROM generations WHERE id = $1', [generationId]);
      if (!owner.rows[0]) return false;
      await lockUser(tx, owner.rows[0].user_id);

      const { rows } = await tx.query(
        `UPDATE generations
            SET status = $2,
                image_data_url = $3,
                error_code = $4,
                error_message = $5,
                finished_at = $6,
                updated_at = $6,
                worker_id = NULL,
                lease_expires_at = NULL
          WHERE id = $1 AND status IN ${ACTIVE_STATUSES}
          RETURNING user_id, quota_day, funding_source`,
        [
          generationId,
          success ? 'done' : 'error',
          success ? imageUrl : null,
          success ? null : failureCode,
          success ? null : PUBLIC_FAILURES[failureCode] ?? PUBLIC_FAILURES.GENERATION_FAILED,
          now,
        ]
      );

      const row = rows[0];
      if (!row) return false;

      if (row.funding_source !== 'free_daily') {
        throw new Error(`Unsupported funding source ${row.funding_source}`);
      }

      const settled = await tx.query(
        success
          ? `UPDATE daily_usage
                SET free_pending = free_pending - 1, free_consumed = free_consumed + 1, updated_at = $3
              WHERE user_id = $1 AND usage_day = $2`
          : `UPDATE daily_usage
                SET free_pending = free_pending - 1, updated_at = $3
              WHERE user_id = $1 AND usage_day = $2`,
        [row.user_id, row.quota_day, now]
      );
      if (settled.rowCount !== 1) {
        throw new Error(`Missing daily usage row for generation ${generationId}`);
      }

      if (success) {
        await tx.query('UPDATE users SET total_completed = total_completed + 1, updated_at = $2 WHERE id = $1', [
          row.user_id,
          now,
        ]);
      }

      return true;
    });
  }

  async function executeJob(row, request, controller) {
    const { signal } = controller;
    try {
      const claimed = await db.query(
        `UPDATE generations SET status = 'processing', updated_at = $2 WHERE id = $1 AND status = 'pending'`,
        [row.id, new Date(clock.now())]
      );
      if (claimed.rowCount !== 1) {
        logger.warn?.(`[generation] ${row.id} was finalised before it started; skipping provider call`);
        return;
      }

      const prompt = buildModePrompt({
        mode: request.mode,
        userPrompt: request.prompt,
        generationMode: request.generationMode,
        variationIndex: 0,
        hasSketch: Boolean(request.sketch),
      });
      const { apiSize } = buildGenerationMode(request.generationMode);
      const requestOptions = { signal, timeout: config.openaiTimeoutMs };

      let result;
      if (request.sketch) {
        const image = await toFile(request.sketch.buffer, sketchFileName(request.sketch.mimeType), {
          type: request.sketch.mimeType,
        });
        result = await openai.images.edit({ model: 'gpt-image-1', image, prompt, size: apiSize }, requestOptions);
      } else {
        result = await openai.images.generate({ model: 'gpt-image-1', prompt, size: apiSize }, requestOptions);
      }

      if (signal.aborted) throw signal.reason;

      const imageUrl = getImageUrlFromResult(result);
      if (!imageUrl) throw new Error('No image returned from OpenAI');

      await finalize(row.id, { success: true, imageUrl });
    } catch (error) {
      const failureCode = classifyFailure(error, signal);
      logger.warn?.(`[generation] ${row.id} failed: ${failureCode}`, error?.status ?? '', error?.message ?? '');
      try {
        await finalize(row.id, { success: false, failureCode });
      } catch (finalizeError) {
        // The lease expires and recoverInterruptedJobs() releases the reservation.
        logger.error?.(`[generation] ${row.id} could not be finalised`, finalizeError?.code || finalizeError?.message);
      }
    }
  }

  function launchJob(row, request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new JobAbort('GENERATION_TIMEOUT')), config.jobTimeoutMs);
    timer.unref?.();

    const promise = executeJob(row, request, controller).finally(() => {
      clearTimeout(timer);
      inFlight.delete(row.id);
    });
    inFlight.set(row.id, { controller, promise });
    return promise;
  }

  return {
    workerId,

    /**
     * Reserves one free Basic slot and starts the job. Outcomes:
     *   created  - new generation, job running
     *   replay   - same idempotency key and payload; nothing new started
     *   conflict - same idempotency key with a different payload
     *   limit    - no free slot left for the current UTC day
     */
    async startFreeGeneration({ userId, idempotencyKey, request }) {
      let outcome;
      try {
        outcome = await reserveFreeGeneration({ userId, idempotencyKey, request });
      } catch (error) {
        if (!idempotencyKey || !isUniqueViolation(error, 'generations_idempotency_unique')) throw error;
        const existing = await findByIdempotencyKey(db, userId, idempotencyKey);
        if (!existing) throw error;
        outcome = replayOutcome(existing, request.requestHash);
      }

      if (outcome.type === 'created') {
        outcome.job = launchJob(outcome.row, request);
      } else if (outcome.type === 'replay') {
        outcome.job = inFlight.get(outcome.row.id)?.promise ?? null;
      }
      return outcome;
    },

    async getOwnedGeneration(userId, generationId) {
      const { rows } = await db.query('SELECT * FROM generations WHERE id = $1 AND user_id = $2', [generationId, userId]);
      return rows[0] ?? null;
    },

    async listOwnedGenerations(userId, limit) {
      const { rows } = await db.query(
        'SELECT * FROM generations WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT $2',
        [userId, limit]
      );
      return rows;
    },

    async renewLeases() {
      if (inFlight.size === 0) return 0;
      const nowMs = clock.now();
      const result = await db.query(
        `UPDATE generations SET lease_expires_at = $2
          WHERE worker_id = $1 AND status IN ${ACTIVE_STATUSES}`,
        [workerId, new Date(nowMs + config.jobLeaseMs)]
      );
      return result.rowCount;
    },

    /**
     * Fails generations whose worker stopped renewing its lease (crash,
     * restart, lost instance) or that exceeded the maximum job duration,
     * releasing their free reservations.
     */
    async recoverInterruptedJobs() {
      const nowMs = clock.now();
      const { rows } = await db.query(
        `SELECT id FROM generations
          WHERE status IN ${ACTIVE_STATUSES}
            AND (lease_expires_at IS NULL OR lease_expires_at < $1 OR started_at < $2)
          ORDER BY started_at
          LIMIT 500`,
        [new Date(nowMs), new Date(nowMs - config.jobTimeoutMs - config.jobLeaseMs)]
      );

      let recovered = 0;
      for (const { id } of rows) {
        if (await finalize(id, { success: false, failureCode: 'INTERRUPTED' })) {
          recovered += 1;
        }
        inFlight.get(id)?.controller.abort(new JobAbort('INTERRUPTED'));
      }
      if (recovered) logger.warn?.(`[generation] recovered ${recovered} interrupted generation(s)`);
      return recovered;
    },

    async cleanupRetention() {
      const nowMs = clock.now();
      const now = new Date(nowMs);
      const imageCutoff = new Date(nowMs - config.imageRetentionHours * 60 * 60 * 1000);
      const recordCutoff = new Date(nowMs - config.recordRetentionDays * 24 * 60 * 60 * 1000);
      const usageCutoffDay = getUtcDayKey(nowMs - config.usageRetentionDays * 24 * 60 * 60 * 1000);
      const totals = { imagesPurged: 0, recordsDeleted: 0, usageRowsDeleted: 0 };

      for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch += 1) {
        const result = await db.query(
          `UPDATE generations SET image_data_url = NULL, image_purged_at = $1, updated_at = $1
            WHERE id IN (
              SELECT id FROM generations
               WHERE image_data_url IS NOT NULL AND finished_at < $2
               LIMIT ${RETENTION_BATCH_SIZE}
            )`,
          [now, imageCutoff]
        );
        totals.imagesPurged += result.rowCount;
        if (result.rowCount < RETENTION_BATCH_SIZE) break;
      }

      for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch += 1) {
        const result = await db.query(
          `DELETE FROM generations
            WHERE id IN (
              SELECT id FROM generations WHERE finished_at < $1 LIMIT ${RETENTION_BATCH_SIZE}
            )`,
          [recordCutoff]
        );
        totals.recordsDeleted += result.rowCount;
        if (result.rowCount < RETENTION_BATCH_SIZE) break;
      }

      const usageResult = await db.query('DELETE FROM daily_usage WHERE usage_day < $1 AND free_pending = 0', [
        usageCutoffDay,
      ]);
      totals.usageRowsDeleted = usageResult.rowCount;

      return totals;
    },

    activeJobCount() {
      return inFlight.size;
    },

    async waitForIdle() {
      while (inFlight.size) {
        await Promise.allSettled([...inFlight.values()].map((job) => job.promise));
      }
    },

    async interruptAll() {
      for (const job of inFlight.values()) {
        job.controller.abort(new JobAbort('INTERRUPTED'));
      }
      await this.waitForIdle();
    },
  };
}

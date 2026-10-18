export const FREE_DAILY_LIMIT = 3;

export function getUtcDayKey(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export function getNextUtcMidnightIso(timestampMs) {
  const date = new Date(timestampMs);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
}

export async function getUsage(db, { userId, nowMs }) {
  const dayKey = getUtcDayKey(nowMs);
  const { rows } = await db.query(
    `SELECT u.total_completed,
            COALESCE(d.free_consumed, 0) AS free_consumed,
            COALESCE(d.free_pending, 0) AS free_pending
       FROM users u
       LEFT JOIN daily_usage d ON d.user_id = u.id AND d.usage_day = $2
      WHERE u.id = $1`,
    [userId, dayKey]
  );
  const row = rows[0] ?? { total_completed: 0, free_consumed: 0, free_pending: 0 };
  return {
    userId,
    dayKey,
    resetsAt: getNextUtcMidnightIso(nowMs),
    consumed: Number(row.free_consumed),
    pending: Number(row.free_pending),
    totalCompleted: Number(row.total_completed),
  };
}

/**
 * Public usage payload. Field names match the pre-authentication contract;
 * premium flags are always false because no paid entitlement exists yet.
 */
export function toUsagePayload(usage, { sessionId = null } = {}) {
  const remainingToday = Math.max(0, FREE_DAILY_LIMIT - usage.consumed);
  const remainingToStart = Math.max(0, FREE_DAILY_LIMIT - usage.consumed - usage.pending);
  return {
    sessionId,
    userId: usage.userId,
    userKey: usage.userId,
    deviceId: null,
    isPremium: false,
    dailyCount: usage.consumed,
    pendingCount: usage.pending,
    dailyLimit: FREE_DAILY_LIMIT,
    remainingToday,
    remainingToStart,
    totalCount: usage.totalCompleted,
    resetDayKey: usage.dayKey,
    resetsAt: usage.resetsAt,
    canStartGeneration: remainingToStart > 0,
    canUsePremiumMode: false,
    canUseVariations: false,
  };
}

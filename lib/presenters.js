function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function toMs(value) {
  return value ? new Date(value).getTime() : null;
}

/**
 * Public generation shape. Field names match the pre-authentication contract.
 * Internal columns (request hash, worker lease, idempotency key) are never exposed.
 */
export function toPublicGeneration(row, { usageSnapshot } = {}) {
  const imageDataUrl = row.image_data_url ?? null;
  const imageBase64 = imageDataUrl?.startsWith('data:image/') ? imageDataUrl.split(',')[1] ?? null : null;
  const isDone = row.status === 'done';

  return {
    id: row.id,
    sessionId: row.client_session_id ?? null,
    userKey: row.user_id,
    deviceId: null,
    sourceGenerationId: row.source_generation_id ?? null,
    prompt: row.prompt,
    type: row.kind,
    mimeType: row.mime_type ?? 'image/jpeg',
    hasSketch: Boolean(row.has_sketch),
    imageBase64,
    imageDataUrl,
    imageExpired: Boolean(row.image_purged_at),
    generationMode: row.generation_mode,
    mode: row.mode,
    consumptionSource: null,
    status: row.status,
    error:
      row.status === 'error'
        ? { code: row.error_code ?? 'GENERATION_FAILED', message: row.error_message ?? 'Image generation failed.' }
        : null,
    variationSeed: null,
    variationIntent: null,
    meta: {
      promptUsed: row.prompt,
      mode: row.mode,
    },
    createdAt: toIso(row.created_at),
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    updatedAt: toMs(row.updated_at),
    ...(isDone ? { completedAt: toMs(row.finished_at) } : {}),
    variationIndex: row.variation_index ?? 0,
    ...(usageSnapshot ? { usageSnapshot } : {}),
  };
}

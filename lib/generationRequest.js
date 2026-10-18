import { createHash } from 'node:crypto';
import { normalizeText } from './promptBuilder.js';

export const FREE_MODE = 'product';
export const FREE_GENERATION_MODE = 'balanced';

const AI_MODES = new Set(['product', 'architect', 'mechanical', 'artist']);
const PAID_AI_MODES = new Set(['architect', 'mechanical', 'artist']);
const GENERATION_MODES = new Set(['fast', 'balanced', 'premium']);
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SESSION_LABEL_MAX = 128;

function reject(status, code, message) {
  return { ok: false, status, code, message };
}

function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function parseSketch(imageBase64, maxSketchBytes) {
  if (imageBase64 === undefined || imageBase64 === null || imageBase64 === '') {
    return { ok: true, value: null };
  }
  if (typeof imageBase64 !== 'string') {
    return reject(400, 'INVALID_IMAGE', 'imageBase64 must be a base64-encoded string.');
  }

  const cleaned = imageBase64.replace(/^data:image\/[\w.+-]+;base64,/, '').replace(/\s+/g, '');
  if (!cleaned || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(cleaned)) {
    return reject(400, 'INVALID_IMAGE', 'imageBase64 must be a base64-encoded string.');
  }

  const approxBytes = Math.floor((cleaned.length * 3) / 4);
  if (approxBytes > maxSketchBytes) {
    return reject(413, 'IMAGE_TOO_LARGE', `The sketch image must be at most ${Math.floor(maxSketchBytes / (1024 * 1024))} MB.`);
  }

  const buffer = Buffer.from(cleaned, 'base64');
  const detectedType = detectImageType(buffer);
  if (!detectedType) {
    return reject(400, 'INVALID_IMAGE', 'The sketch must be a PNG, JPEG or WebP image.');
  }

  return {
    ok: true,
    value: {
      buffer,
      mimeType: detectedType,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    },
  };
}

function parseAiMode(rawMode) {
  if (rawMode === undefined || rawMode === null || rawMode === '') return { ok: true, value: FREE_MODE };
  if (typeof rawMode !== 'string') return reject(400, 'INVALID_MODE', 'Unknown generation mode.');
  const mode = rawMode.trim().toLowerCase();
  if (!AI_MODES.has(mode)) return reject(400, 'INVALID_MODE', 'Unknown generation mode.');
  if (PAID_AI_MODES.has(mode)) {
    return reject(402, 'PAID_MODE_UNAVAILABLE', 'This mode requires coins, which are not available yet.');
  }
  return { ok: true, value: mode };
}

function parseGenerationMode(rawGenerationMode) {
  if (rawGenerationMode === undefined || rawGenerationMode === null || rawGenerationMode === '') {
    return { ok: true, value: FREE_GENERATION_MODE };
  }
  if (typeof rawGenerationMode !== 'string') {
    return reject(400, 'INVALID_GENERATION_MODE', 'Unknown generationMode.');
  }
  const generationMode = rawGenerationMode.trim().toLowerCase();
  if (!GENERATION_MODES.has(generationMode)) {
    return reject(400, 'INVALID_GENERATION_MODE', 'Unknown generationMode.');
  }
  if (generationMode !== FREE_GENERATION_MODE) {
    return reject(403, 'PREMIUM_MODE_REQUIRED', 'This generation mode is not available on the free plan.');
  }
  return { ok: true, value: generationMode };
}

function parseConsumptionSource(rawSource) {
  if (rawSource === undefined || rawSource === null || rawSource === '') return { ok: true };
  const source = String(rawSource).trim().toLowerCase();
  if (source === 'free') return { ok: true };
  if (source === 'coin') {
    return reject(402, 'COIN_PAYMENT_UNAVAILABLE', 'Coin payments are not available yet.');
  }
  return reject(400, 'INVALID_CONSUMPTION_SOURCE', 'Unknown consumptionSource.');
}

export function parseIdempotencyKey(req, { required }) {
  const raw = req.get('idempotency-key');
  if (raw === undefined || raw === '') {
    return required
      ? reject(400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header is required.')
      : { ok: true, value: null };
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    return reject(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 characters of A-Z, a-z, 0-9, ".", "_", ":" or "-".');
  }
  return { ok: true, value: raw };
}

export function parseSessionLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  return label && label.length <= SESSION_LABEL_MAX ? label : null;
}

/**
 * Validates a free Basic generation request. Anything that would require a
 * paid entitlement is rejected here, before any quota is reserved.
 */
export function parseFreeGenerationRequest(body, { maxPromptChars, maxSketchBytes }) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  if (input.prompt !== undefined && input.prompt !== null && typeof input.prompt !== 'string') {
    return reject(400, 'INVALID_INPUT', 'prompt must be a string.');
  }
  const prompt = normalizeText(input.prompt ?? '');
  if (prompt.length > maxPromptChars) {
    return reject(400, 'PROMPT_TOO_LONG', `prompt must be at most ${maxPromptChars} characters.`);
  }

  if (input.mimeType !== undefined && input.mimeType !== null && !ALLOWED_MIME_TYPES.has(String(input.mimeType).toLowerCase())) {
    return reject(400, 'INVALID_MIME_TYPE', 'mimeType must be image/jpeg, image/png or image/webp.');
  }

  const sketch = parseSketch(input.imageBase64, maxSketchBytes);
  if (!sketch.ok) return sketch;

  if (!prompt && !sketch.value) {
    return reject(400, 'INVALID_INPUT', 'Either prompt or imageBase64 is required.');
  }

  const consumption = parseConsumptionSource(input.consumptionSource);
  if (!consumption.ok) return consumption;

  const mode = parseAiMode(input.mode);
  if (!mode.ok) return mode;

  const generationMode = parseGenerationMode(input.generationMode);
  if (!generationMode.ok) return generationMode;

  const mimeType = sketch.value?.mimeType ?? null;
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        prompt,
        mode: mode.value,
        generationMode: generationMode.value,
        sketchSha256: sketch.value?.sha256 ?? null,
      })
    )
    .digest('hex');

  return {
    ok: true,
    value: {
      prompt,
      mode: mode.value,
      generationMode: generationMode.value,
      sketch: sketch.value,
      mimeType,
      sessionLabel: parseSessionLabel(input.sessionId),
      requestHash,
    },
  };
}

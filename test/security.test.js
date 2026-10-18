import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAKE_PNG_BASE64, setup } from './helpers.js';

test('users cannot read or act on each other\'s generations, sessions or usage', async (t) => {
  const { api, service } = await setup(t);
  const alice = await api.issueAccount();
  const bob = await api.issueAccount();

  const started = await api.startGeneration(alice.accessToken, {
    body: { prompt: 'alice private cabinet', sessionId: 'shared-session' },
  });
  assert.equal(started.status, 200);
  await service.waitForIdle();
  const generationId = started.body.generation.id;
  assert.match(generationId, /^gen_[0-9a-f]{32}$/);

  const own = await api.get(`/generation/${generationId}`, { token: alice.accessToken });
  assert.equal(own.status, 200);
  assert.equal(own.body.generation.userKey, alice.userId);

  const foreign = await api.get(`/generation/${generationId}`, { token: bob.accessToken });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.code, 'GENERATION_NOT_FOUND');
  assert.doesNotMatch(foreign.text, /alice private cabinet|data:image/);

  const foreignVariation = await api.post(`/generation/${generationId}/variation`, {
    token: bob.accessToken,
    body: {},
  });
  assert.equal(foreignVariation.status, 404);
  assert.equal(foreignVariation.body.code, 'BASE_NOT_FOUND');

  // The same session label does not merge identities.
  const bobSession = await api.get('/session/shared-session', { token: bob.accessToken });
  assert.equal(bobSession.status, 200);
  assert.equal(bobSession.body.userKey, bob.userId);
  assert.deepEqual(bobSession.body.items, []);

  const aliceSession = await api.get('/session/shared-session', { token: alice.accessToken });
  assert.equal(aliceSession.body.items.length, 1);
  assert.equal(aliceSession.body.items[0].id, generationId);

  // deviceId / sessionId parameters cannot select another user's usage.
  const bobUsage = await api.get(`/usage/shared-session?deviceId=${alice.userId}`, { token: bob.accessToken });
  assert.equal(bobUsage.body.usage.userId, bob.userId);
  assert.equal(bobUsage.body.usage.dailyCount, 0);
  const aliceUsage = await api.get('/usage/shared-session', { token: alice.accessToken });
  assert.equal(aliceUsage.body.usage.dailyCount, 1);

  const missing = await api.get('/generation/gen_ffffffffffffffffffffffffffffffff', { token: alice.accessToken });
  assert.equal(missing.status, 404);
});

test('consumptionSource "coin" is never accepted as payment', async (t) => {
  const { api, openai, service } = await setup(t);
  const { accessToken } = await api.issueAccount();

  for (const consumptionSource of ['coin', 'COIN', ' Coin ']) {
    const response = await api.startGeneration(accessToken, { body: { prompt: 'a desk', consumptionSource } });
    assert.equal(response.status, 402);
    assert.equal(response.body.code, 'COIN_PAYMENT_UNAVAILABLE');
    assert.equal(response.body.usage.remainingToStart, 3);
  }

  for (let index = 0; index < 3; index += 1) {
    assert.equal((await api.startGeneration(accessToken)).status, 200);
  }
  await service.waitForIdle();

  const afterQuota = await api.startGeneration(accessToken, { body: { prompt: 'a desk', consumptionSource: 'coin' } });
  assert.equal(afterQuota.status, 402);
  const legacy = await api.post('/generate', { token: accessToken, body: { prompt: 'a desk', consumptionSource: 'coin' } });
  assert.equal(legacy.status, 402);
  const unknown = await api.startGeneration(accessToken, { body: { prompt: 'a desk', consumptionSource: 'wallet' } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'INVALID_CONSUMPTION_SOURCE');

  assert.equal(openai.calls.length, 3);
});

test('premium self-activation is rejected and changes nothing', async (t) => {
  const { api, openai } = await setup(t);
  const { accessToken } = await api.issueAccount();

  const response = await api.post('/session/my-session/premium', {
    token: accessToken,
    body: { isPremium: true, deviceId: 'device-1' },
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'PREMIUM_ACTIVATION_DISABLED');
  assert.equal(response.body.usage.isPremium, false);

  const usage = (await api.usage(accessToken)).body.usage;
  assert.equal(usage.isPremium, false);
  assert.equal(usage.dailyLimit, 3);
  assert.equal(usage.canUsePremiumMode, false);
  assert.equal(usage.canUseVariations, false);

  const premiumMode = await api.startGeneration(accessToken, { body: { prompt: 'a lamp', generationMode: 'premium' } });
  assert.equal(premiumMode.status, 403);
  assert.equal(premiumMode.body.code, 'PREMIUM_MODE_REQUIRED');
  assert.equal(openai.calls.length, 0);
});

test('the legacy /generate route is authenticated and shares the free quota', async (t) => {
  const { api, openai } = await setup(t);

  const anonymous = await api.post('/generate', { body: { prompt: 'a stool' } });
  assert.equal(anonymous.status, 401);
  assert.equal(openai.calls.length, 0);

  const { accessToken } = await api.issueAccount();

  const viaStart = await api.startGeneration(accessToken);
  assert.equal(viaStart.status, 200);

  for (let index = 0; index < 2; index += 1) {
    const response = await api.post('/generate', { token: accessToken, body: { prompt: 'a stool' } });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.match(response.body.imageUrl, /^data:image\/png;base64,/);
    assert.match(response.body.generationId, /^gen_[0-9a-f]{32}$/);
    assert.equal(response.body.generationMode, 'balanced');
  }

  const overQuota = await api.post('/generate', { token: accessToken, body: { prompt: 'a stool' } });
  assert.equal(overQuota.status, 429);
  assert.equal(overQuota.body.code, 'DAILY_LIMIT_REACHED');

  const startOverQuota = await api.startGeneration(accessToken);
  assert.equal(startOverQuota.status, 429);

  const paidMode = await api.post('/generate', { token: accessToken, body: { prompt: 'a stool', mode: 'artist' } });
  assert.equal(paidMode.status, 402);

  assert.equal(openai.calls.length, 3);
});

test('legacy /generate reports failures safely and releases the slot', async (t) => {
  const { api } = await setup(t, { openaiOptions: { mode: 'fail' } });
  const { accessToken } = await api.issueAccount();

  const response = await api.post('/generate', { token: accessToken, body: { prompt: 'a bench' } });
  assert.equal(response.status, 502);
  assert.equal(response.body.code, 'LEGACY_FAILED');
  assert.doesNotMatch(response.text, /sk-should-not-leak|Upstream failure/);
  assert.equal((await api.usage(accessToken)).body.usage.remainingToStart, 3);
});

test('variations and paid modes cannot bypass paid-mode restrictions', async (t) => {
  const { api, openai, service } = await setup(t);
  const { accessToken } = await api.issueAccount();

  const base = await api.startGeneration(accessToken);
  assert.equal(base.status, 200);
  await service.waitForIdle();
  const baseId = base.body.generation.id;
  const callsAfterBase = openai.calls.length;

  for (const body of [
    {},
    { consumptionSource: 'coin' },
    { generationMode: 'premium' },
    { mode: 'architect' },
    { isPremium: true },
  ]) {
    const response = await api.post(`/generation/${baseId}/variation`, { token: accessToken, body });
    assert.equal(response.status, 403, JSON.stringify(body));
    assert.equal(response.body.code, 'PREMIUM_VARIATION_REQUIRED');
  }

  for (const mode of ['architect', 'mechanical', 'artist', 'ARCHITECT']) {
    const response = await api.startGeneration(accessToken, { body: { prompt: 'a house', mode } });
    assert.equal(response.status, 402, mode);
    assert.equal(response.body.code, 'PAID_MODE_UNAVAILABLE');
  }

  for (const generationMode of ['fast', 'premium', 'Premium']) {
    const response = await api.startGeneration(accessToken, { body: { prompt: 'a house', generationMode } });
    assert.equal(response.status, 403, generationMode);
    assert.equal(response.body.code, 'PREMIUM_MODE_REQUIRED');
  }

  for (const [field, value, code] of [
    ['mode', 'pro', 'INVALID_MODE'],
    ['mode', 'architect ', 'PAID_MODE_UNAVAILABLE'],
    ['mode', 42, 'INVALID_MODE'],
    ['generationMode', 'pro', 'INVALID_GENERATION_MODE'],
    ['generationMode', 'ultra', 'INVALID_GENERATION_MODE'],
  ]) {
    const response = await api.startGeneration(accessToken, { body: { prompt: 'a house', [field]: value } });
    assert.equal(response.body.code, code, `${field}=${JSON.stringify(value)}`);
    assert.ok(response.status === 400 || response.status === 402);
  }

  const explicitBasic = await api.startGeneration(accessToken, {
    body: { prompt: 'a cabinet', mode: 'Product', generationMode: 'BALANCED', consumptionSource: 'free' },
  });
  assert.equal(explicitBasic.status, 200);
  assert.equal(explicitBasic.body.generation.mode, 'product');
  assert.equal(explicitBasic.body.generation.generationMode, 'balanced');
  await service.waitForIdle();

  assert.equal(openai.calls.length, callsAfterBase + 1);
  assert.equal((await api.usage(accessToken)).body.usage.dailyCount, 2);
});

test('sketch uploads are validated and sent to the image edit endpoint', async (t) => {
  const { api, openai, service } = await setup(t);
  const { accessToken } = await api.issueAccount();

  const withSketch = await api.startGeneration(accessToken, {
    body: { prompt: 'two doors', imageBase64: `data:image/png;base64,${FAKE_PNG_BASE64}`, mimeType: 'image/jpeg' },
  });
  assert.equal(withSketch.status, 200);
  assert.equal(withSketch.body.generation.hasSketch, true);
  assert.equal(withSketch.body.generation.mimeType, 'image/png');
  await service.waitForIdle();

  assert.equal(openai.calls.length, 1);
  const [call] = openai.calls;
  assert.equal(call.kind, 'edit');
  assert.equal(call.params.model, 'gpt-image-1');
  assert.equal(call.params.size, '1024x1024');
  assert.match(call.params.prompt, /PRODUCT MODE/);
  assert.ok(call.options.signal instanceof AbortSignal);

  for (const imageBase64 of ['not base64 !!', Buffer.from('plain text, not an image').toString('base64'), 123]) {
    const response = await api.startGeneration(accessToken, { body: { imageBase64 } });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'INVALID_IMAGE');
  }

  const empty = await api.startGeneration(accessToken, { body: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, 'INVALID_INPUT');

  const longPrompt = await api.startGeneration(accessToken, { body: { prompt: 'x'.repeat(4001) } });
  assert.equal(longPrompt.status, 400);
  assert.equal(longPrompt.body.code, 'PROMPT_TOO_LONG');

  const badMime = await api.startGeneration(accessToken, { body: { prompt: 'x', mimeType: 'image/gif' } });
  assert.equal(badMime.status, 400);
  assert.equal(badMime.body.code, 'INVALID_MIME_TYPE');

  assert.equal(openai.calls.length, 1);
});

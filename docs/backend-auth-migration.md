# Backend security foundation: API changes, frontend migration and rollout

Status: **not deployable to production yet.** Every generation, usage and
session route now requires a server-issued bearer token. The current Android
client does not send one and will receive `401` on those routes. Production
deployment stays blocked until the client changes below are shipped and tested
against a staging backend.

## 1. Identity model

- `POST /auth/anonymous` creates a server-side user (`usr_…`, 128-bit random)
  and returns an access token (`mai_…`, 256-bit random). Only the SHA-256 hash
  of the token is stored.
- The token is the only credential. `sessionId` and `deviceId` are ignored for
  identity; `sessionId` is kept only as an optional label on generations.
- The identity is anonymous and **not recoverable**: the server has no way to
  give a lost token back. Clearing app data, reinstalling or moving to a new
  device loses the identity together with everything tied to it (usage,
  server-side generations, and any future balance). The next launch starts a
  new account with a new free quota.
- A rejected token (`401 AUTH_INVALID`) is never a reason to create a new
  identity. The client keeps it and shows an error (see §3, step 3).
- A recoverable account can later be linked to the same `users.id`; ownership
  of usage and generations does not change when that happens. **A recoverable
  account mechanism must be implemented and tested before real coin sales are
  enabled**; anonymous identity alone must never hold purchased coins.
- Tokens do not expire. Revocation is supported server-side (`auth_tokens.revoked_at`)
  as an operator action; a revoked token receives `401 AUTH_INVALID`.

## 2. API contract

All error responses keep the existing shape:
`{ "ok": false, "error": "<message>", "code": "<CODE>", ...extra }`.

| Route | Auth | Change |
|---|---|---|
| `GET /` | none | unchanged |
| `GET /plans` | none | unchanged, adds `available` per plan (`premium.available: false`) |
| `GET /health` | none | **new**, checks database connectivity |
| `POST /auth/anonymous` | none | **new**, returns `201 { ok, userId, accessToken, tokenType: "Bearer", accountType: "anonymous", recoverable: false, usage }` |
| `GET /usage` | Bearer | **new**, same payload as `/usage/:sessionId` |
| `GET /usage/:sessionId` | Bearer | usage of the token's user; `sessionId` is echoed only |
| `GET /session/:sessionId` | Bearer | returns the token's user's 20 most recent generations; never `404 SESSION_NOT_FOUND` |
| `POST /session/:sessionId/premium` | Bearer | always `403 PREMIUM_ACTIVATION_DISABLED`; nothing changes |
| `GET /generation/:id` | Bearer | `404 GENERATION_NOT_FOUND` unless the generation belongs to the token's user |
| `POST /generation/start` | Bearer + `Idempotency-Key` | free Basic only (see below) |
| `POST /generation/:id/variation` | Bearer | `404 BASE_NOT_FOUND` if not owned, otherwise always `403 PREMIUM_VARIATION_REQUIRED` |
| `POST /generate` (legacy, synchronous) | Bearer | same validation and free quota as `/generation/start`; `Idempotency-Key` optional; failure is `502 LEGACY_FAILED` |

### `POST /generation/start`

Headers:

- `Authorization: Bearer <accessToken>` (required)
- `Idempotency-Key: <8–128 chars of A-Z a-z 0-9 . _ : ->` (required)

Body (unchanged field names): `prompt`, `imageBase64`, `mimeType`, `mode`,
`generationMode`, `sessionId`, `consumptionSource`. `deviceId` is ignored.

Accepted free Basic request: `mode` missing or `product`; `generationMode`
missing or `balanced`; `consumptionSource` missing, `null` or `free`.
Matching is case-insensitive.

| Condition | Status | Code |
|---|---|---|
| neither `prompt` nor `imageBase64` | 400 | `INVALID_INPUT` |
| `prompt` longer than 4000 characters | 400 | `PROMPT_TOO_LONG` |
| `imageBase64` not a PNG/JPEG/WebP | 400 | `INVALID_IMAGE` |
| decoded sketch larger than 16 MiB | 413 | `IMAGE_TOO_LARGE` |
| request body larger than 25 MiB | 413 | `PAYLOAD_TOO_LARGE` |
| `mimeType` other than jpeg/png/webp | 400 | `INVALID_MIME_TYPE` |
| unknown `mode` (e.g. `pro`) | 400 | `INVALID_MODE` |
| `mode` = `architect` / `mechanical` / `artist` | 402 | `PAID_MODE_UNAVAILABLE` |
| unknown `generationMode` | 400 | `INVALID_GENERATION_MODE` |
| `generationMode` = `fast` / `premium` | 403 | `PREMIUM_MODE_REQUIRED` |
| `consumptionSource` = `coin` | 402 | `COIN_PAYMENT_UNAVAILABLE` |
| other `consumptionSource` | 400 | `INVALID_CONSUMPTION_SOURCE` |
| missing / malformed `Idempotency-Key` | 400 | `IDEMPOTENCY_KEY_REQUIRED` / `INVALID_IDEMPOTENCY_KEY` |
| 3 free starts already consumed or pending today (UTC) | 429 | `DAILY_LIMIT_REACHED` (includes `usage`) |
| key reused with a different body | 409 | `IDEMPOTENCY_KEY_REUSED` |
| same key and same body again | 200 | original generation, `idempotentReplay: true`, header `Idempotent-Replayed: true` |
| too many requests | 429 | `RATE_LIMITED` (header `Retry-After`) |
| missing / invalid token | 401 | `AUTH_REQUIRED` / `AUTH_INVALID` |

The sketch type is detected from the image bytes; a mislabelled `mimeType`
is corrected rather than rejected.

Success response shape is unchanged: `{ ok: true, usage, generation }`.

### Usage payload

Unchanged fields: `sessionId`, `userKey` (now the user id), `deviceId` (always
`null`), `isPremium` (always `false`), `dailyCount`, `pendingCount`,
`dailyLimit` (3), `remainingToday`, `remainingToStart`, `totalCount`,
`resetDayKey`, `canStartGeneration`, `canUsePremiumMode` (`false`),
`canUseVariations` (`false`).
New fields: `userId`, `resetsAt` (next 00:00 UTC, ISO 8601).

### Generation payload

Field names are unchanged. Differences:

- `id` is `gen_` + 32 hex characters.
- `consumptionSource`, `variationSeed`, `variationIntent`, `deviceId` are always `null`.
- `error` is `{ code, message }` with a safe message. Codes:
  `GENERATION_FAILED`, `GENERATION_TIMEOUT`, `CONTENT_REJECTED`, `INTERRUPTED`.
  Raw provider errors are no longer returned.
- `usageSnapshot` is present on start and on `GET /generation/:id` and reflects current usage.
- New `imageExpired: true` once the image was purged by retention
  (default 24 h after completion; `imageDataUrl` and `imageBase64` become `null`).
  Records are deleted after 30 days, then `GET` returns `404`.
- A generation whose server restarted mid-job ends as `status: "error"`,
  `error.code: "INTERRUPTED"`, and its free slot is released (within about two
  minutes: 90 s lease plus the 30 s recovery sweep).

## 3. Required Android client changes

1. Call `POST /auth/anonymous` only when no identity has ever been stored on
   this installation. Store `accessToken` and `userId` together in encrypted
   storage (e.g. EncryptedSharedPreferences). Never log the token. Do not
   regenerate it on every launch. A failed or unavailable storage read is not
   "no identity": show an error instead of creating a new account.
   On `429 RATE_LIMITED` from `/auth/anonymous`, back off using `Retry-After`.
2. Send `Authorization: Bearer <accessToken>` on every call to `/usage*`,
   `/session/*`, `/generation/*` and `/generate`.
3. On `401 AUTH_INVALID` with a stored token:
   - keep the stored token and `userId`; do not delete or overwrite them;
   - stop authenticated operations (no further generation starts or polling);
   - show a recoverable error state, e.g. "Your account could not be verified"
     with a manual retry that re-sends the same stored token;
   - do not call `POST /auth/anonymous` and do not retry the request with a
     newly created account.
   `401 AUTH_REQUIRED` means the header was not sent; treat it as a client
   defect and handle it the same way.
4. For each user tap on Generate, create one random `Idempotency-Key`
   (UUID v4) and reuse it for every network retry of that same tap. Use a new
   key for a new tap. Do not reuse a key with a changed prompt or image (`409`).
5. Stop sending `consumptionSource: "coin"`, `isPremium`, and the premium
   activation call. Treat `402 PAID_MODE_UNAVAILABLE`,
   `402 COIN_PAYMENT_UNAVAILABLE`, `403 PREMIUM_MODE_REQUIRED` and
   `403 PREMIUM_VARIATION_REQUIRED` as "not available yet" and keep the
   Architect / Mechanical / Artist modes and variations locked in the UI.
6. Send `mode: "product"` (or omit it) and `generationMode: "balanced"` (or omit it)
   for free Basic generations.
7. Use `usage.remainingToStart` / `canStartGeneration` for the free counter and
   `usage.resetsAt` for the reset time (00:00 UTC, not device-local midnight).
8. Handle `status: "error"` with `error.code` and `error.message`; the message is safe to show.
9. Save the finished image on the device; the server copy expires after 24 h
   (`imageExpired: true`).
10. Stop treating `sessionId` / `deviceId` as an account; they no longer select data.

## 4. Rollout plan

1. **Staging backend.** Create a Render PostgreSQL instance and a separate
   staging web service from this branch. Set the environment variables in §5.
   Confirm `GET /health` and the first-boot migration log line.
2. **Proxy check.** On staging, call `POST /auth/anonymous` from two networks
   and confirm the rate limiter distinguishes them (see `TRUST_PROXY` below).
3. **Client build.** Implement §3 against staging. Test: first launch, restart,
   3 free images, the 4th rejected, a failed generation releasing a slot, a
   retried tap not charged twice, flight-mode retries, UTC midnight reset, and
   a revoked token showing the error state without creating a new account.
4. **Production database.** Create the production PostgreSQL instance.
   The current production backend has no persistent data to migrate.
5. **Coordinated cut-over.** The new backend rejects the current client's
   generation requests (`401`). Either release the updated client first through
   a staged Play rollout while the old backend still serves the old client, then
   switch the backend; or keep the old backend URL running for old clients and
   point the new client at a new backend URL. Do not add an unauthenticated
   fallback on the new backend.
6. **Monitor** logs for `[generation] … failed`, `recovered … interrupted`, 5xx
   rates and database size for the first days.

Rollback: redeploy the previous commit. The database tables are additive and
can stay in place.

## 5. Deployment prerequisites

Required environment variables:

- `OPENAI_API_KEY`
- `DATABASE_URL`: Render **Internal** Database URL for the same region.
  If the external URL is used instead, verify its TLS settings on staging first.
- `NODE_ENV=production`
- `TRUST_PROXY`: hop count of the hosting proxy (start with `1` on Render and
  verify on staging). `true` is rejected because it allows IP spoofing.

Optional: see `.env.example` (limits, retention, CORS for browser origins only).

Operational notes:

- Migrations run automatically at startup (`MIGRATE_ON_START=true`) under a
  Postgres advisory lock, or explicitly with `npm run migrate`.
- Storage: a finished image is stored as base64 in Postgres for 24 h,
  roughly 2–3 MB each. Size the database for peak daily images × 3 MB.
- Rate limits are in-memory per instance. Free quota and idempotency are
  enforced in the database and remain correct with several instances.
- On `SIGTERM` the server waits up to 20 s for running jobs, then marks the
  rest as interrupted and releases their slots.

## 6. Known limitations

- Anonymous identity is not recoverable after reinstall, app-data clearing or
  device loss. The old account and its data stay on the server but cannot be
  reached again.
- New anonymous accounts get a new free quota. Reinstalling the app therefore
  resets the quota; `POST /auth/anonymous` is rate-limited per IP to bound this.
  Device attestation (Play Integrity) is a later hardening step.
- No wallet, coin purchase, coin deduction, paid mode or paid variation exists.
  The schema rejects any funding source other than `free_daily`.
- Real coin sales (Google Play Billing) stay blocked until a recoverable
  account mechanism is implemented and tested. This work package adds no
  authentication provider.

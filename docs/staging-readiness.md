# Staging readiness: separate Render staging service

Scope: backend commit `76347300d07e742ad50d1ea329bbb65cf551e427` (authenticated
contract, see `docs/backend-auth-migration.md`). This runbook sets up a
**separate** staging service. The existing production service
(`sketchit-backend-plov`, old API contract) is not touched.

No real credentials, tokens or private URLs belong in this file. Placeholders
are written as `<...>`.

## 1. What was verified locally (2026-10-18)

Environment: Windows, Node 24.14.0, PostgreSQL 16.15 in a throwaway Docker
container bound to `127.0.0.1`, SSL enabled with a self-signed certificate.
OpenAI was replaced by a local fake endpoint through `OPENAI_BASE_URL`; the
fake only accepted a dummy key. No real OpenAI call was made.

| Area | Result |
|---|---|
| `npm test` with PGlite | 33/33 pass |
| `npm test` with real PostgreSQL (`TEST_DATABASE_URL`, pool of 20 connections) | 33/33 pass |
| Real `server.js` processes, `NODE_ENV=production`, `TRUST_PROXY=1`, `TZ=Pacific/Kiritimati` (UTC+14) | 75/77 checks pass; the two open points are listed in §10 |

Covered by the process-level run: startup guards, concurrent first boot of two
instances (migration applied once), repeated migrations, the HTTP contract in
§6, 24 parallel starts for one user across two processes (exactly 3 accepted),
20 parallel starts with the same `Idempotency-Key` across two processes (one
generation and one provider call), mixed success and failure load
(no 5xx responses, consumed count equals done rows, nothing left pending), crash recovery by another
instance (about 20 s), boot-time recovery, persistence of tokens across
restarts, the UTC day boundary, rate limiting and `X-Forwarded-For` handling,
database restarts, and log redaction.

Reproduce the committed part:

```
docker run -d --name <container> -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=<user> -e POSTGRES_PASSWORD=<random> -e POSTGRES_DB=<db> postgres:16
TEST_DATABASE_URL=postgresql://<user>:<random>@127.0.0.1:55432/<db> npm test
```

Each test creates and drops its own schema. Never point `TEST_DATABASE_URL` at
a staging or production database.

## 2. Required infrastructure

| Resource | Notes |
|---|---|
| Render PostgreSQL, new instance (`<name>-staging-db`) | Never reuse a production database. PostgreSQL 16 was tested. Choose the plan deliberately: the free plan expires after a limited period and is deleted. |
| Render Web Service, new (`<name>-staging`), same region as the database | Separate service. Do not change the production service. |
| OpenAI: none in phase 1 | Phase 2 (paid) needs a dedicated OpenAI project and key with a budget limit. |
| A staging Git ref | A `staging` branch at the approved commit, not `main` (see §3, step 0). |

Storage: finished images are stored as base64 in PostgreSQL for 24 h (about
2–3 MB each). 1 GB is enough for several hundred retained images.

## 3. Render setup (separate service)

0. **Protect production before any push.** `7634730` currently exists only
   locally (`main` is one commit ahead of `origin/main`). In the Render
   dashboard, open the existing production service and record its
   *Branch* and *Auto-Deploy* settings. If it auto-deploys from `main`, pushing
   `main` replaces production with the new contract and breaks installed apps
   (`401`). Push the commit to a separate branch instead:
   `git push origin 7634730:refs/heads/staging`. Push to `main` only as part of
   an approved production release.
1. Create the PostgreSQL instance (same region as step 2). Copy its
   **Internal Database URL**.
2. Create a new Web Service from the repository:
   - Branch: `staging`; Auto-Deploy: **Off** (deploy manually).
   - Runtime: Node. Build command: `npm ci --omit=dev`.
   - Start command: `node server.js` (run Node directly so it receives `SIGTERM`).
   - Health check path: `/health`.
   - Instances: 1.
3. Set the environment variables (§4), marking secrets as secret.
4. Deploy manually. Expect the log lines `[migrate] applied 001_initial_schema`
   and `Server running on port <PORT>`.

Start order is enforced by `server.js`: configuration is validated, then
migrations run (under an advisory lock), then interrupted jobs are recovered,
and only then does the server listen. Verified locally: an invalid configuration, an unreachable
database or a wrong password exits with code 1 before listening. A failed
deploy therefore never receives traffic.
If the plan offers a pre-deploy command, `npm run migrate` can run there
instead; `MIGRATE_ON_START=true` remains safe because migrations are locked
and idempotent (two instances booting at the same time applied the migration once).

## 4. Environment variables

Phase 1: no OpenAI traffic. This is the default for staging.

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Enforces the `TRUST_PROXY` requirement. |
| `TRUST_PROXY` | `1` | Assumption; must be verified on Render (§5). `true` is rejected at start. |
| `DATABASE_URL` | `<Internal Database URL of the staging DB>` | Secret. See TLS below. |
| `OPENAI_API_KEY` | `staging-openai-disabled` | Not a key. The variable must be non-empty. |
| `OPENAI_BASE_URL` | `http://127.0.0.1:9/v1` | Kill switch: the SDK honours this variable and connects to a closed local port. |
| `NODE_VERSION` | `24` | Matches the tested runtime. `engines` (`>=20.6`) alone floats. |
| `AUTH_RATE_LIMIT_PER_HOUR` | `5` | Lower than the default (20) to limit free accounts per IP on staging. |
| `CORS_ORIGINS` | *(empty)* | The native app needs no CORS. Only set it for an explicit browser client. |
| `MIGRATE_ON_START` | `true` | Default. |

Verified locally with this exact kill-switch configuration: start `200`, then
generation `error` / `GENERATION_FAILED` after 0.7 s, free quota unchanged
(3 remaining), log `[generation] … failed: GENERATION_FAILED  Connection error.`

Phase 2: real OpenAI calls, only after the release gates in §8.

- Remove `OPENAI_BASE_URL`.
- `OPENAI_API_KEY` = a key from a dedicated OpenAI staging project with a
  budget limit. Never reuse the production key, and never put it in `EXPO_PUBLIC_*`
  variables, `eas.json`, the app repository or logs.

**TLS for `DATABASE_URL`.** Use the Internal Database URL (private network,
same region). Verified local driver behaviour (`pg` 8.23.1):

| URL suffix | Result |
|---|---|
| none | Connects without TLS. Acceptable only on the internal network. |
| `?sslmode=require` | Treated as `verify-full`. Fails on self-signed or private-CA certificates. |
| `?sslmode=no-verify` or `?sslmode=require&uselibpqcompat=true` | Encrypted, certificate not verified. |

Do not use the External Database URL for the service. If it is ever needed,
test `sslmode=verify-full` against Render's certificate first.

## 5. Smoke tests on staging (no cost in phase 1)

PowerShell 7, `$B = 'https://<staging-service>.onrender.com'`:

```
Invoke-RestMethod "$B/health"                                   # { ok: true }
$a = Invoke-RestMethod -Method Post "$B/auth/anonymous"         # 201, tokenType Bearer, recoverable false
$h = @{ Authorization = "Bearer $($a.accessToken)" }
(Invoke-RestMethod "$B/usage" -Headers $h).usage                # dailyLimit 3, remainingToStart 3, resetsAt next 00:00 UTC
Invoke-WebRequest "$B/usage" -SkipHttpErrorCheck | % StatusCode # 401 (AUTH_REQUIRED)
$k = [guid]::NewGuid().ToString()
$body = '{"prompt":"smoke","mode":"product","generationMode":"balanced"}'
$s = Invoke-RestMethod -Method Post "$B/generation/start" -Headers ($h + @{ 'Idempotency-Key' = $k }) -ContentType 'application/json' -Body $body
Invoke-RestMethod -Method Post "$B/generation/start" -Headers ($h + @{ 'Idempotency-Key' = $k }) -ContentType 'application/json' -Body $body  # idempotentReplay: true
(Invoke-RestMethod "$B/generation/$($s.generation.id)" -Headers $h).generation  # phase 1: status error, GENERATION_FAILED
(Invoke-RestMethod "$B/usage" -Headers $h).usage.remainingToStart                # still 3
```

Do not paste real tokens into tickets or chats.

**Proxy check (sets `TRUST_PROXY`).** Temporarily set `AUTH_RATE_LIMIT_PER_HOUR=3`:

1. From network A, send 4 × `POST /auth/anonymous`, each with a different
   spoofed header `X-Forwarded-For: 192.0.2.<n>`. The 4th must be `429`. If it
   is not, the hop count is too high and clients can spoof their IP.
2. From network B (for example a mobile hotspot), send 1 × `POST /auth/anonymous`. It must be
   `201`. If it is `429`, the hop count is too low and all clients share the proxy IP.
3. Restore `AUTH_RATE_LIMIT_PER_HOUR=5`.

Both behaviours were reproduced locally with `TRUST_PROXY=1` / `false`; the
actual Render hop count can only be confirmed this way.

**Further staging checks:** first-boot and redeploy logs (`SIGTERM` handling,
migration no-op), an app restart that reuses the same `userId`, token revocation
(`UPDATE auth_tokens SET revoked_at = now() WHERE user_id = '<id>'`), and the
`/health` behaviour while the database restarts during a Render maintenance window.

## 6. Verified HTTP contract (local, real PostgreSQL)

| Request | Status | Relevant fields |
|---|---|---|
| `GET /health` | 200 | `{ ok: true }`; 503 `UNHEALTHY` when the DB refuses connections |
| `POST /auth/anonymous` | 201 | `userId` `usr_<32 hex>`, `accessToken` `mai_<43>`, `tokenType: Bearer`, `accountType: anonymous`, `recoverable: false`, `usage` |
| `GET /usage` valid token | 200 | `dailyLimit 3`, `remainingToStart 3`, `resetDayKey` = UTC date (also with server TZ UTC+14), `resetsAt` next 00:00 UTC |
| `GET /usage` no token | 401 | `AUTH_REQUIRED`, `WWW-Authenticate: Bearer` |
| `GET /usage` malformed, unknown or `Basic` | 401 | `AUTH_INVALID` |
| `POST /generation/start` Basic (app-shaped body, UUID key) | 200 | `generation.status: pending`, `usage.pendingCount 1` |
| same key + same body (same or other instance) | 200 | same `generation.id`, `idempotentReplay: true`, header `Idempotent-Replayed: true` |
| same key + different body | 409 | `IDEMPOTENCY_KEY_REUSED` |
| missing `Idempotency-Key` | 400 | `IDEMPOTENCY_KEY_REQUIRED` |
| 3 successful starts, then a 4th | 429 | `DAILY_LIMIT_REACHED`, `usage.dailyCount 3` |
| failed generation | 200, then poll | `status: error`, `error.code: GENERATION_FAILED`, safe message; `dailyCount` unchanged |
| `mode` architect, mechanical or artist | 402 | `PAID_MODE_UNAVAILABLE` |
| `generationMode` fast or premium | 403 | `PREMIUM_MODE_REQUIRED` |
| `consumptionSource: coin` | 402 | `COIN_PAYMENT_UNAVAILABLE` |
| `POST /session/:id/premium` | 403 | `PREMIUM_ACTIVATION_DISABLED` |
| `GET /generation/:id` by another user | 404 | `GENERATION_NOT_FOUND` |
| `GET /generation/:id` without token | 401 | `AUTH_REQUIRED` |

Rejected paid requests created no rows, made no provider calls and used no quota.

## 7. Frontend configuration (no code change needed)

The app selects the contract at build time (`services/apiConfig.ts`, frontend
doc `docs/backend-auth-integration.md`):

```
EXPO_PUBLIC_API_CONTRACT=authenticated
EXPO_PUBLIC_API_BASE_URL=https://<staging-service>.onrender.com
```

- `authenticated` requires an explicit HTTPS URL and refuses the legacy
  production host. Unset or `legacy` keeps the current production behaviour.
- Tokens are stored per origin and only sent to that origin. The staging
  service must not redirect to another host.
- Only `EXPO_PUBLIC_API_*` belongs in the app. No OpenAI variable exists in the frontend.
- Use `.env.local` for development builds only. Remove it before any production build.

## 8. Gates before real OpenAI calls (phase 2)

All of the following must be true:

1. Phase 1 smoke tests and the proxy check (§5) pass on Render; `TRUST_PROXY` is confirmed.
2. A dedicated OpenAI staging project and key exist, with a budget limit set and confirmed to work.
3. A named approver has signed off on the expected number of test images.
4. Logs have been checked for redaction on Render (no tokens, no keys).
5. The frontend tester uses a development build pointing at the staging URL only.

Upper bound per day: 3 images × number of anonymous accounts. Accounts are
limited per IP by `AUTH_RATE_LIMIT_PER_HOUR`, so the budget limit is the real cap.

## 9. Teardown

1. Set the phase 1 values again (`OPENAI_API_KEY=staging-openai-disabled`,
   `OPENAI_BASE_URL=http://127.0.0.1:9/v1`), then revoke the staging OpenAI key
   in the OpenAI dashboard.
2. Suspend the staging web service.
3. Delete the staging database (all staging users and images are removed).
4. Delete the `staging` branch if it is no longer needed.
5. Remove `.env.local` from frontend test machines and uninstall staging builds.

## 10. Risks, open decisions, missing evidence

Findings from the local run:

- **`/health` hangs on an unresponsive database.** With the DB container
  paused, `/health` did not answer within 30 s instead of returning 503;
  other DB routes behave the same. The pool has no query timeout or TCP
  keepalive. A refused connection (DB restart) correctly gives 503 and the pool
  reconnects; the server process survives. Render treats a health-check
  timeout as a failure, so this does not block staging, but a pool-level query
  timeout or keepalive should be designed and reviewed before production.
- **Provider error messages are logged verbatim**
  (`[generation] … failed: GENERATION_FAILED <status> <message>`). Clients never
  see them. OpenAI masks keys in its own messages; still, review the log content
  on staging.
- Rate limits are in memory and per instance. They reset on every deploy.

Open decisions:

- Render plans for the staging database and service (free tiers expire or spin down).
- Whether staging should ever leave phase 1, and the budget for phase 2.
- Branch and Auto-Deploy policy of the production service before any push to `main` (§3, step 0).
- A recoverable account mechanism before any coin or purchase (`PURCHASES_ENABLED` stays `false`).
- Production cut-over: needs a new production URL and an approved release (see
  `docs/backend-auth-migration.md` §4). Do not switch the existing production
  URL in place.

Evidence only obtainable on Render:

- The actual proxy hop count (`TRUST_PROXY`).
- The `SIGTERM` timing on redeploy (graceful shutdown is covered by an
  in-process test; Windows cannot deliver `SIGTERM` to a local process).
- The certificate and TLS behaviour of the Render database URL.
- The health-check timeout and cold-start behaviour of the chosen plan.
- Behaviour during Render database maintenance.
- A real OpenAI generation (phase 2 only).

# Staging readiness: separate Render staging service

Scope: backend commit `76347300d07e742ad50d1ea329bbb65cf551e427` (authenticated
contract, see `docs/backend-auth-migration.md`) plus the Supabase PostgreSQL 17
compatibility change (migration `002_restrict_data_api_access`, §11). This
runbook sets up a **separate** staging service backed by the dedicated Supabase
project `mainsches-ai-staging`. The existing production service
(`sketchit-backend-plov`, old API contract) is not touched. The Supabase
database of Mainsches Hub belongs to another product and must never be used.

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
| After the Supabase change: `npm test` with PGlite | all pass except 2 skipped (need real PostgreSQL) |
| After the Supabase change: `npm test` with PostgreSQL 17.11 (Docker, `127.0.0.1`) | all pass, none skipped |
| `pg` 8.23.1 TLS against PostgreSQL 17.11 with a private test CA | see §11.3 |

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

Each test creates and drops its own schema. The test helpers refuse any
`TEST_DATABASE_URL` whose host is not `localhost`, `127.0.0.1` or `::1`, so a
staging, Supabase or production database cannot be used by mistake.

## 2. Required infrastructure

| Resource | Notes |
|---|---|
| Supabase project `mainsches-ai-staging` (ref `ggzftvpqeiwwjoohurcv`, `eu-west-1`, PostgreSQL 17.11) | Used only by this staging service. Connection through the session pooler (§11). Never the Mainsches Hub project. |
| Render Web Service, new (`<name>-staging`), region Frankfurt (closest to `eu-west-1`) | Separate service. Do not change the production service. |
| OpenAI: none in phase 1 | Phase 2 (paid) needs a dedicated OpenAI project and key with a budget limit. |
| A staging Git ref | A `staging` branch at the approved commit, not `main` (see §3, step 0). |

Storage: finished images are stored as base64 in PostgreSQL for 24 h (about
2–3 MB each). 1 GB is enough for several hundred retained images.

## 3. Render setup (separate service)

0. **Protect production before any push.** `origin/staging` is at `bc20f5e`
   (auth contract and this runbook); `origin/main` (`fc7a70c`) is production.
   The local branch is named `main` but carries the staging commits, so a plain
   `git push` would update production. In the Render dashboard, record the
   production service's *Branch* and *Auto-Deploy* settings. Push staging work
   only with an explicit refspec, after review:
   `git push origin <reviewed-commit>:refs/heads/staging`. Push to `main` only as
   part of an approved production release.
1. Prepare the Supabase project as described in §11.6 (CA certificate, SSL
   enforcement, Data API, read-only identity check). Build the session pooler
   URL from §11.2.
2. Create a new Web Service from the repository:
   - Branch: `staging`; Auto-Deploy: **Off** (deploy manually).
   - Runtime: Node. Build command: `npm ci --omit=dev`.
   - Start command: `node server.js` (run Node directly so it receives `SIGTERM`).
   - Health check path: `/health`.
   - Instances: 1.
3. Set the environment variables (§4), marking secrets as secret, and add the
   Supabase CA certificate as the secret file `supabase-ca.crt`.
4. Deploy manually. Expect the log lines `[migrate] applied 001_initial_schema`,
   `[migrate] applied 002_restrict_data_api_access` and `Server running on port <PORT>`.

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
| `DATABASE_URL` | `postgresql://postgres.ggzftvpqeiwwjoohurcv:<db-password>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=/etc/secrets/supabase-ca.crt` | Secret. Session pooler only (§11.2). Percent-encode special characters in the password. |
| `SUPABASE_PROJECT_REF` | `ggzftvpqeiwwjoohurcv` | Not secret. The server refuses to start if `DATABASE_URL` belongs to another project. |
| `DATABASE_POOL_MAX` | `5` | Must be set explicitly: the code default is 10. Must stay below the Supabase session pool size (§11.5). |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `30000` | Default. Server-side `statement_timeout` per session. |
| `HEALTH_CHECK_TIMEOUT_MS` | `5000` | Default. `/health` answers 503 after this time. |
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

**TLS for `DATABASE_URL`.** The Supabase connection crosses the public
internet, so the certificate must be verified: `sslmode=verify-full` plus the
Supabase CA certificate through `sslrootcert` (both required). The server and
`npm run migrate` reject any other Supabase URL; see §11.2 for the exact rules
and §11.3 for the verified driver behaviour.

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
3. Pause or delete the Supabase project `mainsches-ai-staging` (deleting removes
   all staging users and images), or reset only the backend tables (§11.8).
   Reset the database password if it was ever exposed.
4. Delete the `staging` branch if it is no longer needed.
5. Remove `.env.local` from frontend test machines and uninstall staging builds.

## 10. Risks, open decisions, missing evidence

Findings from the local run:

- **Unresponsive database (partly mitigated).** With the DB container paused,
  `/health` originally did not answer within 30 s. Now `/health` answers 503
  after `HEALTH_CHECK_TIMEOUT_MS` (5 s), every session has a server-side
  `statement_timeout` (30 s) and `idle_in_transaction_session_timeout` (60 s),
  and sockets use TCP keepalive. Still open: other routes on a connection whose
  network path is dead wait until the socket fails; how fast that happens
  depends on the host's TCP keepalive settings. A refused connection (DB
  restart) gives 503 and the pool reconnects; the server process survives.
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
- The health-check timeout and cold-start behaviour of the chosen plan.
- A real OpenAI generation (phase 2 only).

Evidence only obtainable against the Supabase project (§11.7): the pooler
certificate chain and host name, session timeouts through the pooler, the
pool size limit, Data API denial, latency from Render Frankfurt, and
behaviour during Supabase maintenance or a pooler restart.

## 11. Supabase PostgreSQL 17 (session pooler)

### 11.1 Decision: session pooler, port 5432

| Connection | Use | Reason |
|---|---|---|
| Session pooler `aws-0-eu-west-1.pooler.supabase.com:5432` | **Yes** | IPv4 (Render has no outbound IPv6). One server connection per client connection for its whole lifetime, so session state behaves like a direct connection. |
| Transaction pooler, port 6543 | No | Rejected at start. Session settings (timeouts) would not stay on the server connection. |
| Direct `db.<ref>.supabase.co:5432` | No | IPv6 only unless the IPv4 add-on is bought. Rejected by the code. |

SQL patterns actually used by the backend, checked against session mode:

| Pattern | Where | Session pooler |
|---|---|---|
| `BEGIN` … `COMMIT`/`ROLLBACK` on one checked-out client | `lib/db.js` `transaction()` | Safe. |
| `pg_advisory_xact_lock` (transaction-scoped) | `lib/migrate.js` | Safe; released on commit or rollback, also in transaction mode. No session-level `pg_advisory_lock` exists in the code. |
| `SELECT … FOR NO KEY UPDATE` row locks | `lib/generationService.js` | Safe; transaction-scoped. |
| `INSERT … ON CONFLICT`, partial indexes, `CHECK` with regex, DDL inside a transaction | migrations, services | Supported by PostgreSQL 17; tested on 17.11. |
| Parameterised queries | everywhere | `pg` uses unnamed prepared statements; no named statements, cursors, `LISTEN`/`NOTIFY` or temporary tables. |
| Session settings via `set_config` after connect | `lib/db.js` `onConnect` | Requires session mode; this is why port 6543 is rejected. |
| `options=-c search_path=…` startup parameter | test helpers only | Never used against Supabase. |

### 11.2 Connection URL and project binding

```
postgresql://postgres.ggzftvpqeiwwjoohurcv:<db-password>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=/etc/secrets/supabase-ca.crt
```

`lib/databaseTarget.js` (used by `server.js` and `npm run migrate`) decides on
the parameters the installed `pg` client actually derives from the URL: it
constructs a `pg.Client` without connecting and inspects its connection
parameters. For every URL it rejects:

- any query parameter given more than once, compared after percent-decoding and
  case-insensitively (`pg` keeps the last value, so
  `sslmode=verify-full&sslmode=disable` or `…&ssl%6Dode=disable` would turn TLS
  off);
- `host`, `hostaddr`, `port`, `user`, `database`, `dbname` and `options` query
  parameters, which `pg` uses to replace parts of the URL;
- a URL whose effective host differs from the host it names.

For a Supabase host it additionally requires:

- `SUPABASE_PROJECT_REF` set;
- the session pooler host (`aws-<n>-<region>.pooler.supabase.com`), port 5432;
- user exactly `postgres.<SUPABASE_PROJECT_REF>` and database `postgres`;
- only the query parameters `sslmode=verify-full` and `sslrootcert`;
- an effective `ssl` configuration with a CA certificate loaded from
  `sslrootcert`, certificate verification on and the default host name check
  in place;
- `NODE_TLS_REJECT_UNAUTHORIZED` not set to `0`.

A Hub URL pasted by mistake therefore fails before any connection, because its
user names a different project. Error messages never repeat the URL or the CA
path. Setting `SUPABASE_PROJECT_REF` with a non-Supabase URL is also rejected.

### 11.3 TLS

Driver behaviour (`pg` 8.23.1), verified against PostgreSQL 17.11 with a
private test CA and a server certificate for `localhost`:

| URL | Result |
|---|---|
| `sslmode=verify-full&sslrootcert=<ca file>`, host in certificate | Connected, TLS 1.3 |
| `sslmode=verify-full` without CA | Rejected (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`) |
| `sslmode=require` without CA | Rejected; `pg` 8 treats `require` as `verify-full` |
| `sslmode=verify-full&sslrootcert=<ca file>`, host not in certificate | Rejected (`ERR_TLS_CERT_ALTNAME_INVALID`) |
| no `sslmode` | Connected without TLS (local only; rejected for Supabase by the config check) |

`sslmode` in the URL replaces any `ssl` object passed in code, so the URL is the
single place where TLS is configured. `sslrootcert` is read from a file.

Setup:

1. Supabase dashboard → Project Settings → Database → SSL configuration:
   download the CA certificate and turn on *Enforce SSL on incoming connections*.
2. Render → staging service → Environment → Secret Files: add it as
   `supabase-ca.crt` (available at `/etc/secrets/supabase-ca.crt`). The CA
   certificate is public, but keep it next to the other connection settings.
3. Never use `sslmode=no-verify`, `rejectUnauthorized: false` or
   `uselibpqcompat=true` to get past a certificate error.

Not yet verified: whether the pooler's certificate chains to the downloaded CA
and lists `aws-0-eu-west-1.pooler.supabase.com`. If the first read-only check
(§11.6) fails with a certificate error, stop and decide explicitly. Do not
weaken verification.

### 11.4 Secrets

- `DATABASE_URL` contains the database password. Store it only as a Render
  secret environment variable. Never commit it, put it in `.env.example`, paste
  it into chats or tickets, or log it.
- The backend logs only error codes and messages for database failures; the
  configuration check never echoes the URL.
- Local `.env` files are git-ignored. `server.js` and `npm run migrate` load
  `.env` through `dotenv`. Any local run against the staging project must set
  the phase 1 OpenAI kill switch (§4) and must not use a real key.
- Rotate the password (Supabase → Database → Reset password, then update the
  Render secret and redeploy) after the test phase or after any suspected
  exposure.

### 11.5 Pool size and timeouts

- In session mode every pooled client holds one server connection. One
  instance uses at most `DATABASE_POOL_MAX` connections, including startup
  migrations (they use the same pool); `npm run migrate` uses one. Set
  `DATABASE_POOL_MAX=5` explicitly (the code default is 10). During a redeploy
  old and new instance briefly run together (up to 10), plus one for a
  pre-deploy migration. Keep this below the pool size shown under Supabase →
  Database → Connection pooling, with room for manual checks. If the limit is
  exceeded, new connections fail and requests return 500 or `/health` 503.
- Per session (`lib/db.js`): `statement_timeout` = `DATABASE_STATEMENT_TIMEOUT_MS`
  (30 s), `idle_in_transaction_session_timeout` = 60 s. No transaction waits on
  OpenAI, so neither limit affects generation. Lock waits count towards
  `statement_timeout`: a second instance waiting on the migration lock gives up
  after 30 s and exits; Render restarts it.
- Client side: connect timeout 10 s, idle client timeout 30 s, TCP keepalive
  after 10 s, `/health` timeout 5 s.

### 11.6 Migration strategy

Both migrations run in one transaction under `pg_advisory_xact_lock`; a failure
rolls everything back and the server does not start. Applied migrations are
checksummed.

`002_restrict_data_api_access` exists because Supabase grants objects in
`public` to its Data API roles (`anon`, `authenticated`, `service_role`),
directly and through default privileges. Without it, anyone with the public
anon key could read token hashes and images through the REST API. The
migration, run as the role that owns the backend tables:

- enables (not forces) row level security on all backend tables, with no
  policies; the owner, which is the backend, keeps full access;
- revokes all table privileges from `PUBLIC` and, where the roles exist, from
  `anon`, `authenticated` and `service_role`. `service_role` has `BYPASSRLS`,
  so for it only the revoke protects the tables;
- revokes the default privileges on tables, sequences and functions from the
  three roles, both schema-level (`IN SCHEMA` current schema) and global. Default
  privileges without `FOR ROLE` only apply to objects created by the role that
  runs the migration, and a schema-level revoke cannot remove a global entry,
  hence both;
- revokes the built-in global default `EXECUTE` on new functions from `PUBLIC`
  for this role (all functions this role creates in the staging database).

All statements are idempotent; the migration system records the migration and
applies it once.

Verified locally on PostgreSQL 17.11 with `anon`, `authenticated` and
`service_role BYPASSRLS` and Supabase-like schema default privileges set before
migrating: none of the roles holds a privilege on a backend table (each gets
`permission denied`), a table, sequence and function created afterwards by the
owner grants nothing to them or to `PUBLIC`, and a mistakenly restored grant
shows `anon` zero rows (RLS) but `service_role` all rows, which is why its
grants are revoked. With the earlier version of the migration, `service_role`
kept access to `auth_tokens` and new tables were granted to `anon`.

Not reproducible locally (open live checks, §11.7): Supabase's actual default
privilege entries, especially entries `FOR ROLE supabase_admin` or other
roles. They only affect objects those roles create; the migrating role cannot
change them unless it is a member of that role.

Before the first deploy (needs explicit approval for read access to the
staging project):

1. Read-only identity check, from a trusted machine, with the URL from §11.2:
   `SELECT current_database(), current_user, version();`,
   `SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid();`
   (expect `true`, TLS 1.2+), and
   `SELECT count(*) FROM pg_tables WHERE schemaname = 'public';` (expect `0`
   for the new project; any existing table means stop, this may not be the
   intended database).
2. Supabase → Project Settings → Data API: turn the Data API off, or remove
   `public` from the exposed schemas. Staging does not need it.
3. Deploy with `MIGRATE_ON_START=true` (or run `npm run migrate` as the Render
   pre-deploy command). Expect both `[migrate] applied …` lines.

### 11.7 Open verification on Supabase (not yet executed)

No connection to the Supabase project has been made. These checks are
required and need explicit approval and the real credentials:

1. TLS: connection with `sslmode=verify-full` and the Supabase CA succeeds
   through the session pooler (§11.3).
2. Identity and empty schema (§11.6, step 1).
3. First deploy: both migrations applied once; a redeploy is a no-op.
4. Session settings through the pooler: `current_setting('statement_timeout')`
   returns `30s` on a backend connection (a one-off read-only query through
   `createPostgresDatabase`).
5. Data API: a REST request to `/rest/v1/users` with the anon key is refused.
   Supabase Security Advisor shows no "RLS disabled" findings.
6. Grants after migrating (read-only): for `anon`, `authenticated` and
   `service_role`, `has_table_privilege` is false on all five backend tables;
   `SELECT defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl FROM pg_default_acl;`
   shows no remaining grants to these roles for the migrating role (`postgres`),
   and the owner of the backend tables is that role
   (`SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public';`).
   Entries for other roles (for example `supabase_admin`) are recorded, not
   changed.
7. Smoke tests and proxy check (§5), with phase 1 OpenAI settings.
8. `pg_stat_activity` shows at most `DATABASE_POOL_MAX` backend connections per
   instance, also during a redeploy.
9. Latency from Render Frankfurt to `eu-west-1` for `POST /generation/start`
   (several round trips per request).

### 11.8 Rollback

- Application: suspend the staging service or redeploy an earlier staging
  commit. Production (`main`, `sketchit-backend-plov`) is never involved.
- A commit without `002_restrict_data_api_access` refuses to start against a
  database where it was applied ("Database has migration … not present in this
  build"). To go back that far, reset the staging tables first.
- Reset of the backend tables, only in the staging project, after confirming
  the project reference in the dashboard:
  `DROP TABLE generations, daily_usage, auth_tokens, users, schema_migrations;`
  This deletes all staging accounts and images; the next start migrates again.
- Do not disable row level security as a rollback step; it would expose the
  tables through the Data API.
- Full teardown: §9.

import { createHash, randomBytes } from 'node:crypto';

const TOKEN_PREFIX = 'mai_';
const TOKEN_PATTERN = /^mai_[A-Za-z0-9_-]{43}$/;
const LAST_USED_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

export function createRandomId(prefix) {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function createAccessToken() {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export async function createAnonymousAccount(db, { clock }) {
  const now = new Date(clock.now());
  const userId = createRandomId('usr');
  const tokenId = createRandomId('tok');
  const accessToken = createAccessToken();

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO users (id, account_type, created_at, updated_at)
       VALUES ($1, 'anonymous', $2, $2)`,
      [userId, now]
    );
    await tx.query(
      `INSERT INTO auth_tokens (id, user_id, token_hash, created_at, last_used_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [tokenId, userId, hashToken(accessToken), now]
    );
  });

  return { userId, accessToken };
}

function readBearerToken(req) {
  const header = req.get('authorization');
  if (!header) return { missing: true };
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return { invalid: true };
  return { token: match[1] };
}

export function createAuthMiddleware({ db, clock, sendError, logger = console }) {
  return async function requireAuth(req, res, next) {
    const { missing, invalid, token } = readBearerToken(req);

    if (missing) {
      res.set('WWW-Authenticate', 'Bearer');
      return sendError(res, 401, 'AUTH_REQUIRED', 'Authentication is required.');
    }

    if (invalid || !TOKEN_PATTERN.test(token)) {
      res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
      return sendError(res, 401, 'AUTH_INVALID', 'The access token is invalid.');
    }

    const { rows } = await db.query(
      `SELECT t.id AS token_id, t.last_used_at, u.id AS user_id, u.account_type
         FROM auth_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1
          AND t.revoked_at IS NULL
          AND u.disabled_at IS NULL`,
      [hashToken(token)]
    );

    const row = rows[0];
    if (!row) {
      res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
      return sendError(res, 401, 'AUTH_INVALID', 'The access token is invalid.');
    }

    req.auth = { userId: row.user_id, tokenId: row.token_id, accountType: row.account_type };

    const nowMs = clock.now();
    if (nowMs - new Date(row.last_used_at).getTime() > LAST_USED_UPDATE_INTERVAL_MS) {
      db.query('UPDATE auth_tokens SET last_used_at = $2 WHERE id = $1', [row.token_id, new Date(nowMs)]).catch(
        (error) => logger.warn?.('[auth] failed to update token last_used_at', error?.code || error?.message)
      );
    }

    return next();
  };
}

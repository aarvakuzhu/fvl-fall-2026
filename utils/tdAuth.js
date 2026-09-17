const crypto = require('crypto');

// The Tournament Director password gates write access to the one official
// draft (OFFICIAL_DRAFT_ID). It's intentionally simple for now — a single
// shared password, not per-user accounts — since there's one TD role per
// season. Change TD_PASSWORD via the Render environment variable when
// you're ready; FVL-Director-2026 is just the default so this works out of
// the box locally.
const TD_PASSWORD = process.env.TD_PASSWORD || '2026';

const OFFICIAL_DRAFT_ID = 'fvl-fall-2026';

// Stateless token: a deterministic HMAC of the password. Any client that
// successfully POSTs the correct password gets this same token back, and
// any request bearing it is trusted — no server-side session store needed.
// This is "good enough for now" auth for a single-password, single-season
// tool, not a general-purpose auth system.
function tokenForPassword(password) {
  return crypto.createHmac('sha256', 'fvl-td-salt').update(password).digest('hex');
}

const VALID_TOKEN = tokenForPassword(TD_PASSWORD);

function checkPassword(password) {
  return typeof password === 'string' && password === TD_PASSWORD;
}

function isValidToken(token) {
  if (typeof token !== 'string' || token.length !== VALID_TOKEN.length) return false;
  // constant-time compare to avoid leaking the token via response-time
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(VALID_TOKEN));
}

module.exports = { OFFICIAL_DRAFT_ID, checkPassword, isValidToken, tokenForPassword, VALID_TOKEN };

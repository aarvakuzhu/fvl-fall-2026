const express = require('express');
const router = express.Router();
const DraftState = require('../models/DraftState');
const Roster = require('../models/Roster');
const { OFFICIAL_DRAFT_ID, checkPassword, isValidToken, VALID_TOKEN } = require('../utils/tdAuth');
const { ROSTER_ID } = require('../utils/constants');
const { readSeedFile, DEFAULT_SEED_PATH } = require('../utils/rosterSeed');

// POST /api/td/auth  { password } -> { token } on success, 401 otherwise.
// The token is the same for everyone (see utils/tdAuth.js) — anyone who
// knows the TD password gets the same write access.
router.post('/td/auth', (req, res) => {
  const { password } = req.body || {};
  if (!checkPassword(password)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  res.json({ token: VALID_TOKEN, draftId: OFFICIAL_DRAFT_ID });
});

// Only the write path to the OFFICIAL draft is gated. Any other draftId is
// a captain's own practice/simulation sandbox (e.g. "sim-john-doe") and
// stays open — no password needed to save your own practice picks.
function requireTdForOfficial(req, res, next) {
  const draftId = req.params.draftId || OFFICIAL_DRAFT_ID;
  if (draftId !== OFFICIAL_DRAFT_ID) return next();

  const token = req.get('x-td-token');
  if (!isValidToken(token)) {
    return res.status(403).json({ error: 'Tournament Director password required for the official draft' });
  }
  next();
}

// GET /api/state/:draftId  -> { draftId, data, updatedAt } or { data: null }
// Reads are always open (viewing isn't gated) for both the official draft
// and any practice sandbox.
router.get('/state/:draftId?', async (req, res) => {
  try {
    const draftId = req.params.draftId || OFFICIAL_DRAFT_ID;
    const doc = await DraftState.findOne({ draftId }).lean();
    if (!doc) return res.json({ draftId, data: null, updatedAt: null });
    res.json({ draftId, data: doc.data, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error('GET /state error:', err);
    res.status(500).json({ error: 'Failed to load draft state' });
  }
});

// PUT /api/state/:draftId  -> upserts the whole blob, broadcasts to other viewers of THIS draftId only
router.put('/state/:draftId?', requireTdForOfficial, async (req, res) => {
  try {
    const draftId = req.params.draftId || OFFICIAL_DRAFT_ID;
    const { data, clientId } = req.body || {};
    if (!data) return res.status(400).json({ error: 'Missing data payload' });

    const doc = await DraftState.findOneAndUpdate(
      { draftId },
      { draftId, data },
      { upsert: true, new: true }
    );

    const io = req.app.get('io');
    if (io) {
      // Broadcast only within this draft's room (its own official session,
      // or one captain's practice sandbox), and skip the tab that made
      // this save so it doesn't re-apply its own change.
      io.to(draftId).emit('state:update', { draftId, data: doc.data, updatedAt: doc.updatedAt, clientId });
    }

    res.json({ ok: true, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error('PUT /state error:', err);
    res.status(500).json({ error: 'Failed to save draft state' });
  }
});

// DELETE /api/state/:draftId -> reset a draft (used by the app's "Reset" button)
router.delete('/state/:draftId?', requireTdForOfficial, async (req, res) => {
  try {
    const draftId = req.params.draftId || OFFICIAL_DRAFT_ID;
    await DraftState.deleteOne({ draftId });

    const io = req.app.get('io');
    if (io) io.to(draftId).emit('state:reset', { draftId });

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /state error:', err);
    res.status(500).json({ error: 'Failed to reset draft state' });
  }
});

// ── Roster (captains + players) ──────────────────────────────────────
// Decoupled from app code: reads are open (both the official draft and
// every practice sandbox need this to build the player pool), writes
// require a valid TD token — same trust level as running the official
// auction, since the roster is shared, canonical data everyone draws from.

// Shared TD-only gate, used by anything that writes shared/canonical data:
// the official draft, the roster, and reseeding the roster.
function requireTd(req, res, next) {
  const token = req.get('x-td-token');
  if (!isValidToken(token)) {
    return res.status(403).json({ error: 'Tournament Director password required' });
  }
  next();
}

// GET /api/roster -> { rosterId, captains, players, updatedAt } or empty arrays if not seeded yet
router.get('/roster', async (req, res) => {
  try {
    const doc = await Roster.findOne({ rosterId: ROSTER_ID }).lean();
    if (!doc) return res.json({ rosterId: ROSTER_ID, captains: [], players: [], updatedAt: null });
    res.json({ rosterId: ROSTER_ID, captains: doc.captains, players: doc.players, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error('GET /roster error:', err);
    res.status(500).json({ error: 'Failed to load roster' });
  }
});

// PUT /api/roster  { captains, players } -> upserts the whole roster (TD only)
router.put('/roster', requireTd, async (req, res) => {
  try {
    const { captains, players } = req.body || {};
    if (!Array.isArray(captains) || !Array.isArray(players)) {
      return res.status(400).json({ error: 'Body must include captains[] and players[]' });
    }
    const doc = await Roster.findOneAndUpdate(
      { rosterId: ROSTER_ID },
      { rosterId: ROSTER_ID, captains, players },
      { upsert: true, new: true }
    );
    res.json({ ok: true, captains: doc.captains.length, players: doc.players.length, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error('PUT /roster error:', err);
    res.status(500).json({ error: 'Failed to save roster' });
  }
});

// POST /api/roster/reseed -> re-reads the bundled data/roster-fall-2026.json
// (whatever is currently committed in the repo) and overwrites the live
// roster with it. This is what the Admin screen's "Reseed" button calls —
// the UI equivalent of running `npm run seed:roster` locally, for a TD who
// doesn't have a local dev setup.
router.post('/roster/reseed', requireTd, async (req, res) => {
  try {
    const seed = readSeedFile();
    if (!seed) {
      return res.status(404).json({ error: `No seed file found on the server at ${DEFAULT_SEED_PATH}` });
    }
    const doc = await Roster.findOneAndUpdate(
      { rosterId: ROSTER_ID },
      { rosterId: ROSTER_ID, captains: seed.captains, players: seed.players },
      { upsert: true, new: true }
    );
    res.json({ ok: true, captains: doc.captains.length, players: doc.players.length, updatedAt: doc.updatedAt, source: seed.filePath });
  } catch (err) {
    console.error('POST /roster/reseed error:', err);
    res.status(500).json({ error: 'Failed to reseed roster' });
  }
});

module.exports = router;

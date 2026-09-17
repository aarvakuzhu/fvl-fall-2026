const express = require('express');
const router = express.Router();
const DraftState = require('../models/DraftState');
const { OFFICIAL_DRAFT_ID, checkPassword, isValidToken, VALID_TOKEN } = require('../utils/tdAuth');

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

module.exports = router;

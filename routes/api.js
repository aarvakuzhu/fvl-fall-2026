const express = require('express');
const router = express.Router();
const DraftState = require('../models/DraftState');

const DEFAULT_DRAFT_ID = 'fvl-fall-2026';

// GET /api/state/:draftId  -> { draftId, data, updatedAt } or { data: null }
router.get('/state/:draftId?', async (req, res) => {
  try {
    const draftId = req.params.draftId || DEFAULT_DRAFT_ID;
    const doc = await DraftState.findOne({ draftId }).lean();
    if (!doc) return res.json({ draftId, data: null, updatedAt: null });
    res.json({ draftId, data: doc.data, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error('GET /state error:', err);
    res.status(500).json({ error: 'Failed to load draft state' });
  }
});

// PUT /api/state/:draftId  -> upserts the whole blob, broadcasts to other viewers
router.put('/state/:draftId?', async (req, res) => {
  try {
    const draftId = req.params.draftId || DEFAULT_DRAFT_ID;
    const { data, clientId } = req.body || {};
    if (!data) return res.status(400).json({ error: 'Missing data payload' });

    const doc = await DraftState.findOneAndUpdate(
      { draftId },
      { draftId, data },
      { upsert: true, new: true }
    );

    const io = req.app.get('io');
    if (io) {
      // Broadcast to everyone except the tab that made this save, so other
      // viewers (director's laptop, projector screen, phones watching along)
      // stay live-synced without re-applying their own change.
      io.emit('state:update', { draftId, data: doc.data, updatedAt: doc.updatedAt, clientId });
    }

    res.json({ ok: true, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error('PUT /state error:', err);
    res.status(500).json({ error: 'Failed to save draft state' });
  }
});

// DELETE /api/state/:draftId -> reset a draft (used by the app's "Reset" button)
router.delete('/state/:draftId?', async (req, res) => {
  try {
    const draftId = req.params.draftId || DEFAULT_DRAFT_ID;
    await DraftState.deleteOne({ draftId });

    const io = req.app.get('io');
    if (io) io.emit('state:reset', { draftId });

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /state error:', err);
    res.status(500).json({ error: 'Failed to reset draft state' });
  }
});

module.exports = router;

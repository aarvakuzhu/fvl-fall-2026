const mongoose = require('mongoose');

/**
 * The client keeps its entire draft state (players, teams, round/queue
 * progress, history, undo stack, mock-draft settings) as one JSON blob,
 * the same shape that used to live in localStorage. Rather than force a
 * rigid schema on a structure that may evolve season to season, we store
 * it as a single Mixed document per draftId, so multiple drafts (e.g.
 * "fvl-fall-2026", "fvl-spring-2027") can coexist in the same collection.
 */
const DraftStateSchema = new mongoose.Schema(
  {
    draftId: { type: String, required: true, unique: true, index: true },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('DraftState', DraftStateSchema);

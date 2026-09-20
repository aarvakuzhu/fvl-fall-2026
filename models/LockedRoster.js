const mongoose = require('mongoose');

/**
 * The boundary between Draft (editable, resettable) and everything
 * downstream (Schedule/Scores/Standings, which must never shift under
 * them). Snapshotted once via POST /api/tournament/lock, TD-only.
 * Schedule/Scores/Standings read ONLY from this collection, never from
 * DraftState directly \u2014 that's what keeps this extractable later without
 * a migration script (see the Tournament Platform doc).
 */
const LockedPlayerSchema = new mongoose.Schema(
  {
    playerId: { type: Number, required: true },
    name:     { type: String, required: true },
    tier:     { type: String, required: true },
    price:    { type: Number, required: true },
    isCaptain: { type: Boolean, default: false },
    pic:      { type: String, default: '' },   // captured at lock time from the draft's player pool, not the team roster entry (which doesn't carry it)
    round:    { type: String, default: '' },   // the tier round they sold in, or "Fire Sale" if they went unsold at least once first
  },
  { _id: false }
);

const LockedTeamSchema = new mongoose.Schema(
  {
    teamId:   { type: Number, required: true }, // portable id \u2014 matches state.teams[].id from the draft, not a Mongo _id
    name:     { type: String, required: true },
    budget:   { type: Number, default: 0 },
    spent:    { type: Number, default: 0 },
    roster:   { type: [LockedPlayerSchema], default: [] },
  },
  { _id: false }
);

const LockedRosterSchema = new mongoose.Schema(
  {
    tournamentId: { type: String, required: true, unique: true, index: true },
    teams:        { type: [LockedTeamSchema], default: [] },
    lockedAt:     { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LockedRoster', LockedRosterSchema);

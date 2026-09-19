const mongoose = require('mongoose');

/**
 * The generic shape of "a tournament's format" \u2014 pool count/size, tier
 * names, prize structure, venue/date. Nothing FVL-specific about the
 * schema itself; a future tournament is just a new document with the same
 * shape, not a new collection or new code.
 *
 * `revealed` is the "keep this under TD, no reveal for others yet" switch:
 * reads of this config (and everything that depends on it \u2014 Schedule,
 * Standings, the flyer) are open once true, TD-only until then. Flip it
 * with PATCH /api/tournament/config/reveal.
 */
const TierSchema = new mongoose.Schema(
  {
    name:  { type: String, required: true },  // e.g. "Gold"
    order: { type: Number, required: true },  // display/priority order, 0 = highest
  },
  { _id: false }
);

const PrizeSchema = new mongoose.Schema(
  {
    award: { type: String, required: true }, // e.g. "Gold Champion"
    tier:  { type: String, default: '' },
    type:  { type: String, default: '' },     // "Trophy" | "Medal" | ...
  },
  { _id: false }
);

const TournamentConfigSchema = new mongoose.Schema(
  {
    tournamentId: { type: String, required: true, unique: true, index: true },
    name:         { type: String, required: true }, // e.g. "FVL Major"
    date:         { type: String, default: '' },     // display string, e.g. "Sat, Oct 10, 2026"
    timeStart:    { type: String, default: '' },
    timeEnd:      { type: String, default: '' },
    postLeagueStart: { type: String, default: '' }, // when the tiered bracket (semis) begins, e.g. "14:10"
    venue:        { type: String, default: '' },
    courts:       { type: Number, default: 1 },

    teamCount:    { type: Number, required: true },
    poolCount:    { type: Number, required: true },
    poolSize:     { type: Number, required: true },  // teams per pool
    poolGamesPerTeam:   { type: Number, default: 0 }, // derived, but stored for display
    tieredGamesPerTeam: { type: Number, default: 0 },

    tiers:  { type: [TierSchema],  default: [] },
    prizes: { type: [PrizeSchema], default: [] },

    revealed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TournamentConfig', TournamentConfigSchema);

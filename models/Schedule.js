const mongoose = require('mongoose');

/**
 * One match. Pool-play matches have real teams from the moment pools are
 * assigned. Tiered-bracket matches (Gold/Silver/Bronze/Copper semis,
 * finals, 3rd-place) can't have real teams until pool standings exist \u2014
 * those get added in the Scores/Standings phase, not here.
 */
const MatchSchema = new mongoose.Schema(
  {
    matchId: { type: String, required: true },      // e.g. "poolA-1v2", "gold-sf1"
    phase:   { type: String, required: true },        // "pool" | "tiered"
    group:   { type: String, required: true },        // pool name "A".."D", or tier name "Gold".."Copper"
    label:   { type: String, required: true },        // display, e.g. "Pool A: 1v2"
    court:   { type: Number, default: null },
    timeStart: { type: String, default: '' },
    timeEnd:   { type: String, default: '' },

    teamAId: { type: Number, default: null },        // portable team id (LockedRoster teamId), null if not yet resolved
    teamBId: { type: Number, default: null },
    teamAName: { type: String, default: '' },          // cached display name, avoids a join for the schedule view
    teamBName: { type: String, default: '' },
    seedA: { type: Number, default: null },              // pool position (1..4) this slot needs — used to re-fill on re-randomization
    seedB: { type: Number, default: null },
    refereeTeamId: { type: Number, default: null },      // a non-playing team's id, drawn from teams free at this timeStart
    refereeTeamName: { type: String, default: '' },

    scoreA: { type: Number, default: null },
    scoreB: { type: Number, default: null },
    completed: { type: Boolean, default: false },

    // Tiered matches only \u2014 how to resolve teamA/teamB once pool
    // standings or semi results exist. { type:'poolRank', pool, rank } or
    // { type:'semiResult', matchId, outcome:'winner'|'loser' }. Shape
    // varies by type, hence Mixed.
    sourceA: { type: mongoose.Schema.Types.Mixed, default: null },
    sourceB: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const PoolAssignmentSchema = new mongoose.Schema(
  {
    pool:   { type: String, required: true },   // "A".."D"
    teamId: { type: Number, required: true },
    teamName: { type: String, required: true },
  },
  { _id: false }
);

const ScheduleSchema = new mongoose.Schema(
  {
    tournamentId: { type: String, required: true, unique: true, index: true },
    pools:        { type: [PoolAssignmentSchema], default: [] }, // the random draw result
    matches:      { type: [MatchSchema], default: [] },
    poolsLocked:  { type: Boolean, default: false }, // TD marks the pool draw final; blocks further re-randomization until unlocked
    generatedAt:  { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Schedule', ScheduleSchema);

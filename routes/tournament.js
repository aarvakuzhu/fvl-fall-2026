const express = require('express');
const router = express.Router();

const LockedRoster = require('../models/LockedRoster');
const TournamentConfig = require('../models/TournamentConfig');
const Schedule = require('../models/Schedule');
const DraftState = require('../models/DraftState');
const { isValidToken, OFFICIAL_DRAFT_ID } = require('../utils/tdAuth');
const { buildPoolSkeleton, assignPoolsToSkeleton, assignReferees, buildTieredSkeleton } = require('../utils/scheduleGen');
const { computePoolStandings, resolveTieredMatches } = require('../utils/standings');

const TOURNAMENT_ID = 'fvl-major-oct-2026'; // one active tournament for now

function requireTd(req, res, next) {
  if (!isValidToken(req.get('x-td-token'))) {
    return res.status(403).json({ error: 'Tournament Director password required' });
  }
  next();
}

// Gate reads on the config's `revealed` flag \u2014 open once true, TD-only
// until then ("keep this under TD, no reveal for others yet").
async function requireRevealedOrTd(req, res, next) {
  if (isValidToken(req.get('x-td-token'))) return next();
  try {
    const cfg = await TournamentConfig.findOne({ tournamentId: TOURNAMENT_ID }).lean();
    if (cfg && cfg.revealed) return next();
    return res.status(403).json({ error: 'Not revealed yet' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to check reveal status' });
  }
}

// ── Lock Teams ──────────────────────────────────────────────────────────
// Snapshots the CURRENT official draft's teams into LockedRoster. This is
// the one-way door: everything downstream reads only from this snapshot,
// never from DraftState, so Draft stays freely resettable without ever
// disturbing Schedule/Scores/Standings once locked.
router.post('/lock', requireTd, async (req, res) => {
  try {
    const draft = await DraftState.findOne({ draftId: OFFICIAL_DRAFT_ID }).lean();
    if (!draft || !draft.data || !Array.isArray(draft.data.teams) || draft.data.teams.length === 0) {
      return res.status(404).json({ error: 'No official draft state to lock yet' });
    }

    const teams = draft.data.teams.map((t) => ({
      teamId: t.id,
      name: t.name,
      budget: t.budget,
      spent: t.spent,
      roster: (t.roster || []).map((r) => ({
        playerId: r.playerId,
        name: r.playerName,
        tier: r.tier,
        price: r.price,
        isCaptain: !!r.isCaptain,
      })),
    }));

    const doc = await LockedRoster.findOneAndUpdate(
      { tournamentId: TOURNAMENT_ID },
      { $set: { tournamentId: TOURNAMENT_ID, teams, lockedAt: new Date() } },
      { upsert: true, new: true }
    );

    res.json({ ok: true, teams: doc.teams.length, lockedAt: doc.lockedAt });
  } catch (err) {
    console.error('POST /tournament/lock error:', err);
    res.status(500).json({ error: 'Failed to lock teams' });
  }
});

router.get('/locked', requireRevealedOrTd, async (req, res) => {
  try {
    const doc = await LockedRoster.findOne({ tournamentId: TOURNAMENT_ID }).lean();
    if (!doc) return res.json({ locked: false });
    res.json({ locked: true, teams: doc.teams, lockedAt: doc.lockedAt });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load locked roster' });
  }
});

// ── Tournament config ───────────────────────────────────────────────────
router.get('/config', requireRevealedOrTd, async (req, res) => {
  try {
    const cfg = await TournamentConfig.findOne({ tournamentId: TOURNAMENT_ID }).lean();
    res.json(cfg || null);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tournament config' });
  }
});

router.put('/config', requireTd, async (req, res) => {
  try {
    const body = req.body || {};
    const doc = await TournamentConfig.findOneAndUpdate(
      { tournamentId: TOURNAMENT_ID },
      { $set: { ...body, tournamentId: TOURNAMENT_ID } },
      { upsert: true, new: true }
    );
    res.json({ ok: true, config: doc });
  } catch (err) {
    console.error('PUT /tournament/config error:', err);
    res.status(500).json({ error: 'Failed to save tournament config' });
  }
});

router.patch('/config/reveal', requireTd, async (req, res) => {
  try {
    const revealed = !!(req.body && req.body.revealed);
    const doc = await TournamentConfig.findOneAndUpdate(
      { tournamentId: TOURNAMENT_ID },
      { $set: { revealed } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'No tournament config yet' });
    res.json({ ok: true, revealed: doc.revealed });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update reveal status' });
  }
});

// ── Schedule (pool play) ────────────────────────────────────────────────
router.get('/schedule', requireRevealedOrTd, async (req, res) => {
  try {
    const doc = await Schedule.findOne({ tournamentId: TOURNAMENT_ID }).lean();
    res.json(doc || { pools: [], matches: [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load schedule' });
  }
});

// Generates (or re-randomizes) the pool draw and fills it into the
// schedule. Pulls team identity (id + name, captain-name-fallback already
// handled client-side) straight from the LIVE official draft \u2014 no
// dependency on the draft being complete, or on LockedRoster, since which
// 16 teams/captains exist is known from the start of the auction, not the
// end of it. Re-running this reuses the existing skeleton (or builds one
// from config if this is the first run) and only overwrites team
// names/ids \u2014 courts and times never change.
router.post('/schedule/randomize-pools', requireTd, async (req, res) => {
  try {
    const existing = await Schedule.findOne({ tournamentId: TOURNAMENT_ID }).lean();
    if (existing && existing.poolsLocked) {
      return res.status(400).json({ error: 'Pool allocation is locked \u2014 unlock it first if you need to re-randomize.' });
    }

    const draft = await DraftState.findOne({ draftId: OFFICIAL_DRAFT_ID }).lean();
    if (!draft || !draft.data || !Array.isArray(draft.data.teams) || draft.data.teams.length === 0) {
      return res.status(404).json({ error: 'No teams found in the official draft yet' });
    }
    const teams = draft.data.teams.map((t) => ({ teamId: t.id, name: t.name }));

    const cfg = await TournamentConfig.findOne({ tournamentId: TOURNAMENT_ID }).lean();
    if (!cfg) {
      return res.status(400).json({ error: 'No tournament config set yet' });
    }

    const existingPool   = existing ? existing.matches.filter((m) => m.phase === 'pool') : [];
    const existingTiered = existing ? existing.matches.filter((m) => m.phase === 'tiered') : [];

    // Reuse the stored pool skeleton if one exists (keeps courts/times
    // fixed across re-randomization); otherwise build it fresh from config.
    const poolSkeleton = existingPool.length
      ? existingPool
      : buildPoolSkeleton({
          poolCount: cfg.poolCount,
          poolSize: cfg.poolSize,
          courts: cfg.courts,
          matchMinutes: 25,
          startHHMM: cfg.timeStart || '08:40',
        });

    const { pools, matches: poolWithTeams } = assignPoolsToSkeleton(poolSkeleton, teams, cfg.poolCount);
    const poolMatches = assignReferees(poolWithTeams, teams);

    // Tiered skeleton: reuse the existing shape (courts/times never
    // change), but reset every slot's resolution \u2014 whatever teams/scores
    // were previously resolved into it depended on the OLD pool draw and
    // are no longer valid now that pools have changed.
    const tieredSkeleton = existingTiered.length
      ? existingTiered
      : buildTieredSkeleton({
          tiers: cfg.tiers,
          courts: cfg.courts,
          matchMinutes: 25,
          startHHMM: cfg.postLeagueStart || '14:10',
        });
    const tieredMatches = tieredSkeleton.map((m) => ({
      ...m,
      teamAId: null, teamBId: null, teamAName: '', teamBName: '',
      refereeTeamId: null, refereeTeamName: '',
      scoreA: null, scoreB: null, completed: false,
    }));

    const doc = await Schedule.findOneAndUpdate(
      { tournamentId: TOURNAMENT_ID },
      { $set: { tournamentId: TOURNAMENT_ID, pools, matches: poolMatches.concat(tieredMatches), generatedAt: new Date() } },
      { upsert: true, new: true }
    );

    res.json({ ok: true, pools: doc.pools.length, matches: doc.matches.length });
  } catch (err) {
    console.error('POST /tournament/schedule/randomize-pools error:', err);
    res.status(500).json({ error: err.message || 'Failed to randomize pools' });
  }
});

router.patch('/schedule/lock-pools', requireTd, async (req, res) => {
  try {
    const locked = !!(req.body && req.body.locked);
    const doc = await Schedule.findOneAndUpdate(
      { tournamentId: TOURNAMENT_ID },
      { $set: { poolsLocked: locked } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'No schedule to lock yet \u2014 randomize pools first' });
    res.json({ ok: true, poolsLocked: doc.poolsLocked });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update pool lock' });
  }
});

// Enter/update a score for any match (pool or tiered). Every submission
// re-runs the full resolution pipeline: recompute pool standings -> fill
// in any newly-resolvable tiered slots (semis from standings, 3rd/final
// from semi results) -> assign referees for tiered matches that just
// became resolved. Cheap given the total match count (~40), so simplest
// to just redo the whole pass each time rather than track deltas.
router.patch('/schedule/score', requireTd, async (req, res) => {
  try {
    const { matchId, scoreA, scoreB } = req.body || {};
    if (!matchId || typeof scoreA !== 'number' || typeof scoreB !== 'number') {
      return res.status(400).json({ error: 'matchId, scoreA, and scoreB (numbers) are required' });
    }

    const doc = await Schedule.findOne({ tournamentId: TOURNAMENT_ID });
    if (!doc) return res.status(404).json({ error: 'No schedule yet' });

    const match = doc.matches.find((m) => m.matchId === matchId);
    if (!match) return res.status(404).json({ error: 'No such match: ' + matchId });

    match.scoreA = scoreA;
    match.scoreB = scoreB;
    match.completed = true;

    const plainMatches = doc.matches.map((m) => m.toObject());
    const standings = computePoolStandings(doc.pools, plainMatches);
    let resolved = resolveTieredMatches(plainMatches, standings);

    const draft = await DraftState.findOne({ draftId: OFFICIAL_DRAFT_ID }).lean();
    const teams = (draft && draft.data && draft.data.teams) ? draft.data.teams.map((t) => ({ teamId: t.id, name: t.name })) : [];
    if (teams.length) {
      resolved = assignReferees(resolved, teams, { onlyMissing: true });
    }

    doc.matches = resolved;
    await doc.save();

    res.json({ ok: true, standings });
  } catch (err) {
    console.error('PATCH /tournament/schedule/score error:', err);
    res.status(500).json({ error: err.message || 'Failed to save score' });
  }
});

// Standings: pool standings (computed from pool scores) + tiered bracket
// progress. Same open-once-revealed-else-TD-only gate as everything else.
router.get('/standings', requireRevealedOrTd, async (req, res) => {
  try {
    const doc = await Schedule.findOne({ tournamentId: TOURNAMENT_ID }).lean();
    if (!doc || !doc.matches.length) return res.json({ pools: {}, tiered: [] });

    const standings = computePoolStandings(doc.pools, doc.matches);
    const tiered = doc.matches.filter((m) => m.phase === 'tiered');
    res.json({ pools: standings, tiered });
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute standings' });
  }
});

module.exports = router;
module.exports.TOURNAMENT_ID = TOURNAMENT_ID;

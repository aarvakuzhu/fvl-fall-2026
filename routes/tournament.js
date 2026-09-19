const express = require('express');
const router = express.Router();

const LockedRoster = require('../models/LockedRoster');
const TournamentConfig = require('../models/TournamentConfig');
const Schedule = require('../models/Schedule');
const DraftState = require('../models/DraftState');
const { isValidToken, OFFICIAL_DRAFT_ID } = require('../utils/tdAuth');
const { generatePoolSchedule } = require('../utils/scheduleGen');

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
      { tournamentId: TOURNAMENT_ID, teams, lockedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ ok: true, teams: doc.teams.length, lockedAt: doc.lockedAt });
  } catch (err) {
    console.error('POST /tournament/lock error:', err);
    res.status(500).json({ error: 'Failed to lock teams' });
  }
});

router.get('/locked', requireTd, async (req, res) => {
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
      { ...body, tournamentId: TOURNAMENT_ID },
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
      { revealed },
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

// Generates pool assignments + the full pool-play match list from the
// locked roster and the tournament config. TD can re-run this (new random
// draw) any time before the tournament starts; it overwrites the previous
// pool schedule.
router.post('/schedule/generate-pools', requireTd, async (req, res) => {
  try {
    const locked = await LockedRoster.findOne({ tournamentId: TOURNAMENT_ID }).lean();
    if (!locked || !locked.teams.length) {
      return res.status(400).json({ error: 'Lock teams before generating the schedule' });
    }
    const cfg = await TournamentConfig.findOne({ tournamentId: TOURNAMENT_ID }).lean();
    if (!cfg) {
      return res.status(400).json({ error: 'No tournament config set yet' });
    }

    const teams = locked.teams.map((t) => ({ teamId: t.teamId, name: t.name }));
    const { pools, matches } = generatePoolSchedule(teams, {
      poolCount: cfg.poolCount,
      courts: cfg.courts,
      matchMinutes: 25,
      startHHMM: cfg.timeStart || '08:40',
    });

    const doc = await Schedule.findOneAndUpdate(
      { tournamentId: TOURNAMENT_ID },
      { tournamentId: TOURNAMENT_ID, pools, matches, generatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ ok: true, pools: doc.pools.length, matches: doc.matches.length });
  } catch (err) {
    console.error('POST /tournament/schedule/generate-pools error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate schedule' });
  }
});

module.exports = router;
module.exports.TOURNAMENT_ID = TOURNAMENT_ID;

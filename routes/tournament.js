const express = require('express');
const router = express.Router();

const LockedRoster = require('../models/LockedRoster');
const TournamentConfig = require('../models/TournamentConfig');
const Schedule = require('../models/Schedule');
const DraftState = require('../models/DraftState');
const { isValidToken, OFFICIAL_DRAFT_ID } = require('../utils/tdAuth');
const { buildPoolSkeleton, assignPoolsToSkeleton, assignReferees } = require('../utils/scheduleGen');

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

    // Reuse the stored skeleton if one exists (keeps courts/times fixed
    // across re-randomization); otherwise build it fresh from config.
    const skeleton = (existing && existing.matches && existing.matches.length)
      ? existing.matches
      : buildPoolSkeleton({
          poolCount: cfg.poolCount,
          poolSize: cfg.poolSize,
          courts: cfg.courts,
          matchMinutes: 25,
          startHHMM: cfg.timeStart || '08:40',
        });

    const { pools, matches: withTeams } = assignPoolsToSkeleton(skeleton, teams, cfg.poolCount);
    const matches = assignReferees(withTeams, teams);

    const doc = await Schedule.findOneAndUpdate(
      { tournamentId: TOURNAMENT_ID },
      { tournamentId: TOURNAMENT_ID, pools, matches, generatedAt: new Date() },
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
      { poolsLocked: locked },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'No schedule to lock yet \u2014 randomize pools first' });
    res.json({ ok: true, poolsLocked: doc.poolsLocked });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update pool lock' });
  }
});

module.exports = router;
module.exports.TOURNAMENT_ID = TOURNAMENT_ID;

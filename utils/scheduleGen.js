// Pool-play schedule, split into two independent layers:
//
//   1. buildPoolSkeleton(opts)   — the fixed shape: which pool plays which
//      pairing, on which court, at what time. Derived from tournament
//      config ALONE (pool count, court count, match length, start time) —
//      no team data needed, and never changes once the tournament's format
//      is set.
//   2. assignPoolsToSkeleton(...) — the random draw: which actual teams
//      sit in each pool. Can be re-run any time (even repeatedly, even
//      mid-auction) and only ever touches team names/ids on the existing
//      skeleton — courts and times are untouched.
//
// Generalized for any pool count / court count, but the round-robin
// pairing order (1v2, 3v4, 1v3, 2v4, 1v4, 2v3) assumes 4 teams per pool,
// same as this tournament — a future format with a different pool size
// would need a different pairing sequence here.

const RR_ORDER_4 = ['1v2', '3v4', '1v3', '2v4', '1v4', '2v3'];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function toHHMM(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/**
 * @param {{poolCount:number, poolSize:number, courts:number, matchMinutes:number, startHHMM:string}} opts
 * @returns {Array} match slots, teamAId/teamBId/names all null — filled in later by assignPoolsToSkeleton
 */
function buildPoolSkeleton(opts) {
  const { poolCount, poolSize, courts, matchMinutes, startHHMM } = opts;
  if (poolSize !== 4) {
    throw new Error('buildPoolSkeleton currently only supports pools of 4 (round-robin order is hardcoded for that size)');
  }

  const poolNames = Array.from({ length: poolCount }, (_, i) => String.fromCharCode(65 + i));
  const waves = [];
  for (let i = 0; i < poolNames.length; i += courts) {
    waves.push(poolNames.slice(i, i + courts));
  }

  const skeleton = [];
  let clock = toMinutes(startHHMM);

  RR_ORDER_4.forEach((pairing) => {
    const [aSeed, bSeed] = pairing.split('v').map(Number);
    waves.forEach((wavePools) => {
      const timeStart = toHHMM(clock);
      const timeEnd   = toHHMM(clock + matchMinutes);
      wavePools.forEach((poolName, courtIdx) => {
        skeleton.push({
          matchId: `pool${poolName}-${pairing}`,
          phase: 'pool',
          group: poolName,
          label: `Pool ${poolName}: ${pairing}`,
          court: courtIdx + 1,
          timeStart,
          timeEnd,
          seedA: aSeed, // which position (1..4) in the pool this slot needs — resolved to a real team by assignPoolsToSkeleton
          seedB: bSeed,
          teamAId: null,
          teamBId: null,
          teamAName: '',
          teamBName: '',
          scoreA: null,
          scoreB: null,
          completed: false,
        });
      });
      clock += matchMinutes;
    });
  });

  return skeleton;
}

/**
 * Randomly draws `teams` into pools and fills the matching skeleton slots
 * with the resulting team ids/names. Safe to call repeatedly on the same
 * skeleton — each call re-shuffles and re-fills, courts/times untouched.
 *
 * @param {Array} skeleton - from buildPoolSkeleton, or a previously-filled schedule's matches array (seedA/seedB/matchId are what matter, team fields get overwritten)
 * @param {Array<{teamId:number, name:string}>} teams
 * @param {number} poolCount
 * @returns {{pools: Array, matches: Array}}
 */
function assignPoolsToSkeleton(skeleton, teams, poolCount) {
  const poolSize = Math.ceil(teams.length / poolCount);
  const poolNames = Array.from({ length: poolCount }, (_, i) => String.fromCharCode(65 + i));
  const shuffled = shuffle(teams);

  const pools = [];
  const poolTeams = {};
  poolNames.forEach((name, i) => {
    const slice = shuffled.slice(i * poolSize, (i + 1) * poolSize);
    poolTeams[name] = slice;
    slice.forEach((t) => pools.push({ pool: name, teamId: t.teamId, teamName: t.name }));
  });

  const matches = skeleton.map((slot) => {
    const teamA = poolTeams[slot.group][slot.seedA - 1];
    const teamB = poolTeams[slot.group][slot.seedB - 1];
    return {
      ...slot,
      teamAId: teamA.teamId,
      teamBId: teamB.teamId,
      teamAName: teamA.name,
      teamBName: teamB.name,
    };
  });

  return { pools, matches };
}

/**
 * Assigns a referee TEAM to each match, drawn from teams not playing in
 * that same time slot (so they're actually free to ref). Balanced greedy:
 * at each match, picks whichever eligible team has reffed the fewest
 * times so far, so ref duty spreads evenly across the tournament rather
 * than always falling on the same teams. Mutates a copy, doesn't touch
 * court/time/team fields.
 *
 * @param {Array} matches - from assignPoolsToSkeleton, must have teamAId/teamBId/timeStart filled in
 * @param {Array<{teamId:number, name:string}>} teams - all teams
 * @param {{onlyMissing?: boolean}} [opts] - onlyMissing: only assign matches that don't already have a referee (used for tiered matches as they resolve one at a time), keeping existing assignments (and their counts, for fairness) untouched
 * @returns {Array} matches with refereeTeamId/refereeTeamName added
 */
function assignReferees(matches, teams, opts) {
  const onlyMissing = !!(opts && opts.onlyMissing);
  const teamById = new Map(teams.map((t) => [t.teamId, t]));
  const refCount = new Map(teams.map((t) => [t.teamId, 0]));

  // Seed counts from existing assignments so balance accounts for referee
  // duty already locked in elsewhere (pool matches, or tiered matches
  // resolved on an earlier pass), not just the matches being assigned now.
  if (onlyMissing) {
    matches.forEach((m) => {
      if (m.refereeTeamId !== null && refCount.has(m.refereeTeamId)) {
        refCount.set(m.refereeTeamId, refCount.get(m.refereeTeamId) + 1);
      }
    });
  }

  // Busy team ids per time slot, across ALL matches with known teams at
  // that time (not just the pair's own match) \u2014 a team playing on court
  // 1 can't ref court 2's match at the same time either. Matches with
  // unresolved teams (null teamAId/teamBId, e.g. tiered slots not yet
  // determined) simply don't contribute a busy id, which is correct: we
  // only know what we know.
  const busyByTime = new Map();
  matches.forEach((m) => {
    if (!busyByTime.has(m.timeStart)) busyByTime.set(m.timeStart, new Set());
    const s = busyByTime.get(m.timeStart);
    if (m.teamAId !== null) s.add(m.teamAId);
    if (m.teamBId !== null) s.add(m.teamBId);
  });

  return matches.map((m) => {
    if (onlyMissing && m.refereeTeamId !== null) return m; // already assigned, leave it
    if (onlyMissing && (m.teamAId === null || m.teamBId === null)) return m; // can't ref a match whose teams aren't known yet

    const busy = busyByTime.get(m.timeStart) || new Set();
    const eligible = teams.filter((t) => !busy.has(t.teamId));

    if (eligible.length === 0) {
      return onlyMissing ? m : { ...m, refereeTeamId: null, refereeTeamName: '' };
    }

    let best = eligible[0];
    eligible.forEach((t) => {
      if (refCount.get(t.teamId) < refCount.get(best.teamId)) best = t;
    });
    refCount.set(best.teamId, refCount.get(best.teamId) + 1);

    return { ...m, refereeTeamId: best.teamId, refereeTeamName: best.name };
  });
}

// ── Post-league (tiered bracket) ────────────────────────────────────────
//
// Matches the flyer's exact template: tiers pair up by "extremity" (Copper
// + Bronze together first, then Gold + Silver), each pair running through
// 4 rounds in order (Semifinal 1, Semifinal 2, Third Place, Final) before
// the next pair starts. This specific pairing isn't derived generically
// from tier count/order \u2014 it's this tournament's exact structure; a
// future tournament with a different tier count/pairing would need this
// sequence revisited, same caveat as the pool-of-4 assumption above.
const TIER_WAVE_ORDER = [['Copper', 'Bronze'], ['Gold', 'Silver']];

/**
 * @param {{tiers:Array<{name:string,order:number}>, courts:number, matchMinutes:number, startHHMM:string}} opts
 * @returns {Array} match slots \u2014 teams unresolved (sourceA/sourceB describe how to resolve them once pool/semi results exist)
 */
function buildTieredSkeleton(opts) {
  const { tiers, matchMinutes, startHHMM } = opts;
  const tierByName = new Map(tiers.map((t) => [t.name, t]));
  const skeleton = [];
  let clock = toMinutes(startHHMM);

  function makeSlot(tierName, roundLabel, courtIdx) {
    const tier = tierByName.get(tierName);
    if (!tier) return null; // this tournament doesn't have this tier \u2014 skip
    const slug = tierName.toLowerCase();
    const rank = tier.order + 1; // Gold(order 0) -> pool rank 1, Silver -> 2, etc.

    let matchId, label, sourceA, sourceB;
    if (roundLabel === 'Semifinal 1') {
      matchId = `${slug}-sf1`; label = `${tierName} Semifinal 1`;
      sourceA = { type: 'poolRank', pool: 'A', rank };
      sourceB = { type: 'poolRank', pool: 'B', rank };
    } else if (roundLabel === 'Semifinal 2') {
      matchId = `${slug}-sf2`; label = `${tierName} Semifinal 2`;
      sourceA = { type: 'poolRank', pool: 'C', rank };
      sourceB = { type: 'poolRank', pool: 'D', rank };
    } else if (roundLabel === 'Third Place') {
      matchId = `${slug}-3rd`; label = `${tierName} Third Place`;
      sourceA = { type: 'semiResult', matchId: `${slug}-sf1`, outcome: 'loser' };
      sourceB = { type: 'semiResult', matchId: `${slug}-sf2`, outcome: 'loser' };
    } else {
      matchId = `${slug}-final`; label = `${tierName} Final`;
      sourceA = { type: 'semiResult', matchId: `${slug}-sf1`, outcome: 'winner' };
      sourceB = { type: 'semiResult', matchId: `${slug}-sf2`, outcome: 'winner' };
    }

    return {
      matchId, phase: 'tiered', group: tierName, label,
      court: courtIdx + 1, timeStart: '', timeEnd: '',
      sourceA, sourceB,
      teamAId: null, teamBId: null, teamAName: '', teamBName: '',
      refereeTeamId: null, refereeTeamName: '',
      scoreA: null, scoreB: null, completed: false,
    };
  }

  function stampTime(slot) {
    slot.timeStart = toHHMM(clock);
    slot.timeEnd   = toHHMM(clock + matchMinutes);
    return slot;
  }

  // Phase 1 \u2014 semis, grouped BY WAVE: both semis for wave 1 (Copper,
  // Bronze) run before wave 2 (Gold, Silver) starts.
  TIER_WAVE_ORDER.forEach((wave) => {
    ['Semifinal 1', 'Semifinal 2'].forEach((roundLabel) => {
      const timeStart = toHHMM(clock);
      const timeEnd = toHHMM(clock + matchMinutes);
      wave.forEach((tierName, courtIdx) => {
        const slot = makeSlot(tierName, roundLabel, courtIdx);
        if (slot) { slot.timeStart = timeStart; slot.timeEnd = timeEnd; skeleton.push(slot); }
      });
      clock += matchMinutes;
    });
  });

  // Phase 2 \u2014 3rd place then Final, grouped BY ROUND across waves: both
  // waves' 3rd-place matches happen before either wave's Final.
  ['Third Place', 'Final'].forEach((roundLabel) => {
    TIER_WAVE_ORDER.forEach((wave) => {
      const timeStart = toHHMM(clock);
      const timeEnd = toHHMM(clock + matchMinutes);
      wave.forEach((tierName, courtIdx) => {
        const slot = makeSlot(tierName, roundLabel, courtIdx);
        if (slot) { slot.timeStart = timeStart; slot.timeEnd = timeEnd; skeleton.push(slot); }
      });
      clock += matchMinutes;
    });
  });

  return skeleton;
}

module.exports = { buildPoolSkeleton, assignPoolsToSkeleton, assignReferees, buildTieredSkeleton, toHHMM, toMinutes };

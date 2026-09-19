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

module.exports = { buildPoolSkeleton, assignPoolsToSkeleton, toHHMM, toMinutes };

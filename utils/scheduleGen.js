// Generates the pool-play portion of a schedule: random pool draw +
// round-robin match list with court/time assignment. Generalized for any
// pool count / court count, but the round-robin pairing order (1v2, 3v4,
// 1v3, 2v4, 1v4, 2v3) assumes 4 teams per pool, same as this tournament \u2014
// a future format with a different pool size would need a different
// pairing sequence here, everything else about this function stays generic.

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
 * @param {Array<{teamId:number, name:string}>} teams - all locked teams, unassigned
 * @param {{poolCount:number, courts:number, matchMinutes:number, startHHMM:string}} opts
 * @returns {{pools: Array, matches: Array, nextClockMinutes: number}}
 */
function generatePoolSchedule(teams, opts) {
  const { poolCount, courts, matchMinutes, startHHMM } = opts;
  const poolSize = Math.ceil(teams.length / poolCount);
  if (poolSize !== 4) {
    throw new Error('generatePoolSchedule currently only supports pools of 4 (round-robin order is hardcoded for that size)');
  }

  const poolNames = Array.from({ length: poolCount }, (_, i) => String.fromCharCode(65 + i));
  const shuffled = shuffle(teams);

  const pools = [];
  const poolTeams = {};
  poolNames.forEach((name, i) => {
    const slice = shuffled.slice(i * poolSize, (i + 1) * poolSize);
    poolTeams[name] = slice;
    slice.forEach((t) => pools.push({ pool: name, teamId: t.teamId, teamName: t.name }));
  });

  const waves = [];
  for (let i = 0; i < poolNames.length; i += courts) {
    waves.push(poolNames.slice(i, i + courts));
  }

  const matches = [];
  let clock = toMinutes(startHHMM);

  RR_ORDER_4.forEach((pairing) => {
    const [aSeed, bSeed] = pairing.split('v').map(Number);
    waves.forEach((wavePools) => {
      const timeStart = toHHMM(clock);
      const timeEnd   = toHHMM(clock + matchMinutes);
      wavePools.forEach((poolName, courtIdx) => {
        const teamA = poolTeams[poolName][aSeed - 1];
        const teamB = poolTeams[poolName][bSeed - 1];
        matches.push({
          matchId: `pool${poolName}-${pairing}`,
          phase: 'pool',
          group: poolName,
          label: `Pool ${poolName}: ${pairing}`,
          court: courtIdx + 1,
          timeStart,
          timeEnd,
          teamAId: teamA.teamId,
          teamBId: teamB.teamId,
          teamAName: teamA.name,
          teamBName: teamB.name,
          scoreA: null,
          scoreB: null,
          completed: false,
        });
      });
      clock += matchMinutes;
    });
  });

  return { pools, matches, nextClockMinutes: clock };
}

module.exports = { generatePoolSchedule, toHHMM, toMinutes };

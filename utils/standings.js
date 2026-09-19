// Pool standings computation + tiered-bracket resolution. Run this after
// any score changes (see routes/tournament.js) — cheap given the total
// match count (~40), so simplest to just fully recompute every time
// rather than track incremental deltas.
//
// Tiebreaker rule (no rule was specified going in, so this is a documented
// default, easy to change in one place if a different one is wanted):
// match wins -> point differential -> total points scored.

function computePoolStandings(pools, matches) {
  // pools: [{pool, teamId, teamName}, ...]  (the random draw result)
  // matches: schedule matches, phase === 'pool'
  const byPool = {};
  pools.forEach((p) => {
    if (!byPool[p.pool]) byPool[p.pool] = [];
    byPool[p.pool].push({ teamId: p.teamId, teamName: p.teamName, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, played: 0 });
  });

  const poolMatches = matches.filter((m) => m.phase === 'pool');
  poolMatches.forEach((m) => {
    if (!m.completed || m.scoreA === null || m.scoreB === null) return;
    const rows = byPool[m.group];
    if (!rows) return;
    const a = rows.find((r) => r.teamId === m.teamAId);
    const b = rows.find((r) => r.teamId === m.teamBId);
    if (!a || !b) return;
    a.played++; b.played++;
    a.pointsFor += m.scoreA; a.pointsAgainst += m.scoreB;
    b.pointsFor += m.scoreB; b.pointsAgainst += m.scoreA;
    if (m.scoreA > m.scoreB) { a.wins++; b.losses++; } else { b.wins++; a.losses++; }
  });

  const totalMatchesPerPool = {};
  poolMatches.forEach((m) => { totalMatchesPerPool[m.group] = (totalMatchesPerPool[m.group] || 0) + 1; });

  const standings = {};
  Object.keys(byPool).forEach((poolName) => {
    const rows = byPool[poolName].map((r) => ({ ...r, diff: r.pointsFor - r.pointsAgainst }));
    rows.sort((x, y) => (y.wins - x.wins) || (y.diff - x.diff) || (y.pointsFor - x.pointsFor));
    rows.forEach((r, i) => { r.rank = i + 1; });
    const gamesInPool = poolMatches.filter((m) => m.group === poolName).length;
    const gamesComplete = poolMatches.filter((m) => m.group === poolName && m.completed).length;
    standings[poolName] = { rows, complete: gamesInPool > 0 && gamesComplete === gamesInPool };
  });

  return standings;
}

// Resolves as many tiered-bracket slots as currently possible, given pool
// standings and any completed semi/3rd/final results. Safe to call
// repeatedly (idempotent) — only fills in what's newly resolvable, leaves
// everything else untouched.
function resolveTieredMatches(matches, standings) {
  const byMatchId = new Map(matches.map((m) => [m.matchId, m]));

  function resolveSource(src) {
    if (src.type === 'poolRank') {
      const pool = standings[src.pool];
      if (!pool || !pool.complete) return null;
      const row = pool.rows.find((r) => r.rank === src.rank);
      return row ? { teamId: row.teamId, teamName: row.teamName } : null;
    }
    if (src.type === 'semiResult') {
      const sf = byMatchId.get(src.matchId);
      if (!sf || !sf.completed || sf.scoreA === null || sf.scoreB === null) return null;
      const aWon = sf.scoreA > sf.scoreB;
      if (src.outcome === 'winner') {
        return aWon ? { teamId: sf.teamAId, teamName: sf.teamAName } : { teamId: sf.teamBId, teamName: sf.teamBName };
      }
      return aWon ? { teamId: sf.teamBId, teamName: sf.teamBName } : { teamId: sf.teamAId, teamName: sf.teamAName };
    }
    return null;
  }

  return matches.map((m) => {
    if (m.phase !== 'tiered') return m;
    if (m.teamAId !== null && m.teamBId !== null) return m; // already resolved, leave as-is (don't clobber an in-progress/completed match)
    const a = m.sourceA ? resolveSource(m.sourceA) : null;
    const b = m.sourceB ? resolveSource(m.sourceB) : null;
    if (!a && !b) return m;
    return {
      ...m,
      teamAId: a ? a.teamId : m.teamAId,
      teamBId: b ? b.teamId : m.teamBId,
      teamAName: a ? a.teamName : m.teamAName,
      teamBName: b ? b.teamName : m.teamBName,
    };
  });
}

module.exports = { computePoolStandings, resolveTieredMatches };

// Pool standings computation + tiered-bracket resolution. Run this after
// any score changes (see routes/tournament.js) — cheap given the total
// match count (~40), so simplest to just fully recompute every time
// rather than track incremental deltas.
//
// Tiebreaker rule (no rule was specified going in, so this is a documented
// default, easy to change in one place if a different one is wanted):
// match wins -> point differential -> total points scored.

const crypto = require('crypto');

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
    const gamesInPool = poolMatches.filter((m) => m.group === poolName).length;
    const gamesComplete = poolMatches.filter((m) => m.group === poolName && m.completed).length;
    const poolDone = gamesInPool > 0 && gamesComplete === gamesInPool;
    // Teams still level on wins, differential AND points scored: once the pool
    // is finished, order them by a seeded random draw and flag it so the UI can
    // explain it. The draw is a hash of the pool + tied teams + their stats, so
    // it is stable across page loads (no re-rolling) and only changes if a
    // score correction changes the tie itself. While the pool is still in
    // progress the tie is provisional: stable order by team id, not flagged.
    const key = (r) => r.wins + '|' + r.diff + '|' + r.pointsFor;
    let i = 0;
    while (i < rows.length) {
      let j = i;
      while (j + 1 < rows.length && key(rows[j + 1]) === key(rows[i])) j++;
      if (j > i) {
        const group = rows.slice(i, j + 1);
        const ids = group.map((r) => r.teamId).sort((a, b) => a - b).join(',');
        group.forEach((r) => { r._h = crypto.createHash('sha1').update(poolName + '#' + key(r) + '#' + ids + '#' + r.teamId).digest('hex'); });
        group.sort((x, y) => poolDone ? (x._h < y._h ? -1 : 1) : (x.teamId - y.teamId));
        group.forEach((r, k) => {
          rows[i + k] = r;
          delete r._h;
          if (poolDone) { r.randomTie = true; r.tieNote = 'Tied with ' + group.filter((o) => o !== r).map((o) => o.teamName).join(' & ') + ' on wins, point differential and points scored \u2014 order decided by random draw.'; }
        });
      }
      i = j + 1;
    }
    rows.forEach((r, i2) => { r.rank = i2 + 1; });
    standings[poolName] = { rows, complete: poolDone };
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

  // Always re-derive every slot from its source so a corrected score
  // propagates. If a slot's team changes, any score/referee that was based on
  // the old team is cleared (so the TD re-scores it). Looped so a pool fix
  // cascades pool -> semi -> 3rd/final.
  let out = matches;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    out = out.map((m) => {
      byMatchId.set(m.matchId, m);
      if (m.phase !== 'tiered') return m;
      const a = m.sourceA ? resolveSource(m.sourceA) : null;
      const b = m.sourceB ? resolveSource(m.sourceB) : null;
      const newAId = m.sourceA ? (a ? a.teamId : null) : m.teamAId;
      const newBId = m.sourceB ? (b ? b.teamId : null) : m.teamBId;
      if (newAId === m.teamAId && newBId === m.teamBId) return m;
      changed = true;
      const next = {
        ...m,
        teamAId: newAId,
        teamBId: newBId,
        teamAName: m.sourceA ? (a ? a.teamName : '') : m.teamAName,
        teamBName: m.sourceB ? (b ? b.teamName : '') : m.teamBName,
        scoreA: null,
        scoreB: null,
        completed: false,
        refereeTeamId: null,
        refereeTeamName: '',
      };
      byMatchId.set(m.matchId, next);
      return next;
    });
    if (!changed) break;
  }
  return out;
}

module.exports = { computePoolStandings, resolveTieredMatches };

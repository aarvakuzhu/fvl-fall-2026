// Pool standings computation + tiered-bracket resolution. Run this after
// any score changes (see routes/tournament.js) — cheap given the total
// match count (~40), so simplest to just fully recompute every time
// rather than track incremental deltas.
//
// Tiebreaker rule (no rule was specified going in, so this is a documented
// default, easy to change in one place if a different one is wanted):
// match wins -> point differential -> total points scored.

const crypto = require('crypto');

function computePoolStandings(pools, matches, opts) {
  const locked = !!(opts && opts.locked);
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
    const allScored = gamesInPool > 0 && gamesComplete === gamesInPool;
    // Ranks only become final (and feed the bracket) once the TD locks league scores.
    const poolDone = allScored && locked;
    // Teams still level on wins, differential AND points scored: once the pool
    // is locked, order them by a seeded random draw and flag it so the UI can
    // explain it. The draw is a hash of the pool + tied teams + their stats, so
    // it is stable across page loads (no re-rolling) and only changes if a
    // score correction changes the tie itself. Before the lock the tie is provisional: stable order by team id, not flagged.
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
    standings[poolName] = { rows, complete: poolDone, allScored };
  });

  return standings;
}

// Seeds each division (Gold = every pool's #1, Silver = every pool's #2, ...)
// across pools: wins -> point differential -> points scored -> seeded random
// draw (flagged). Only available once every pool is final (league locked).
// Semis are then seed 1 v 4 and seed 2 v 3.
function computeTierSeedings(standings) {
  const poolNames = Object.keys(standings);
  if (!poolNames.length || !poolNames.every((n) => standings[n].complete)) return {};
  const maxRank = Math.max(...poolNames.map((n) => standings[n].rows.length));
  const out = {};
  for (let rank = 1; rank <= maxRank; rank++) {
    const rows = [];
    poolNames.forEach((n) => {
      const r = standings[n].rows.find((x) => x.rank === rank);
      if (r) rows.push({ ...r, pool: n });
    });
    rows.sort((x, y) => (y.wins - x.wins) || (y.diff - x.diff) || (y.pointsFor - x.pointsFor));
    const key = (r) => r.wins + '|' + r.diff + '|' + r.pointsFor;
    let i = 0;
    while (i < rows.length) {
      let j = i;
      while (j + 1 < rows.length && key(rows[j + 1]) === key(rows[i])) j++;
      if (j > i) {
        const group = rows.slice(i, j + 1);
        const ids = group.map((r) => r.teamId).sort((a, b) => a - b).join(',');
        group.forEach((r) => { r._h = crypto.createHash('sha1').update('tier' + rank + '#' + key(r) + '#' + ids + '#' + r.teamId).digest('hex'); });
        group.sort((x, y) => (x._h < y._h ? -1 : 1));
        group.forEach((r, k) => {
          rows[i + k] = r;
          delete r._h;
          r.randomTie = true;
          r.tieNote = 'Tied with ' + group.filter((o) => o !== r).map((o) => o.teamName).join(' & ') + ' on wins, point differential and points scored \u2014 seed decided by random draw.';
        });
      }
      i = j + 1;
    }
    rows.forEach((r, k) => { r.seed = k + 1; });
    out[rank] = rows;
  }
  return out;
}

// Resolves as many tiered-bracket slots as currently possible, given pool
// standings and any completed semi/3rd/final results. Safe to call
// repeatedly (idempotent) — only fills in what's newly resolvable, leaves
// everything else untouched.
function resolveTieredMatches(matches, standings) {
  const seedings = computeTierSeedings(standings);
  const byMatchId = new Map(matches.map((m) => [m.matchId, m]));

  function resolveSource(src) {
    if (src.type === 'tierSeed') {
      const list = seedings[src.rank];
      const row = list && list.find((r) => r.seed === src.seed);
      return row ? { teamId: row.teamId, teamName: row.teamName } : null;
    }
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
  // Semis used to be built as pool-vs-pool by rank (A#1 v B#1). They are now
  // division-seeded (1v4, 2v3); rewrite any stored legacy poolRank sources.
  let out = matches.map((m) => {
    if (m.phase === 'tiered' && /-sf[12]$/.test(m.matchId) && m.sourceA && m.sourceA.type === 'poolRank') {
      const rank = m.sourceA.rank;
      const sf1 = /-sf1$/.test(m.matchId);
      return { ...m, sourceA: { type: 'tierSeed', rank, seed: sf1 ? 1 : 2 }, sourceB: { type: 'tierSeed', rank, seed: sf1 ? 4 : 3 } };
    }
    return m;
  });
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

module.exports = { computePoolStandings, computeTierSeedings, resolveTieredMatches };

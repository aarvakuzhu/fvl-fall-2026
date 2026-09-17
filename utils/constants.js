// One roster document per season. Bump this when a new season's roster
// replaces the current one (e.g. "spring-2027") rather than overwriting
// "fall-2026" in place, so past seasons stay in MongoDB for reference.
const ROSTER_ID = 'fall-2026';

module.exports = { ROSTER_ID };

const fs = require('fs');
const path = require('path');

const DEFAULT_SEED_PATH = path.join(__dirname, '..', 'data', 'roster-fall-2026.json');

// Reads and validates the bundled roster JSON. Returns null (not a throw)
// if the file is missing, so callers can decide how to handle that —
// boot-time seeding just warns and moves on; the admin reseed endpoint
// returns a clear 404 to the TD instead of a generic 500.
function readSeedFile(seedPath) {
  const filePath = seedPath || DEFAULT_SEED_PATH;
  if (!fs.existsSync(filePath)) return null;

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const captains = Array.isArray(raw.captains) ? raw.captains : [];
  const players  = Array.isArray(raw.players)  ? raw.players  : [];
  return { captains, players, filePath };
}

module.exports = { readSeedFile, DEFAULT_SEED_PATH };

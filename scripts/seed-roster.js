// Pushes data/roster-fall-2026.json (or a path you pass) into MongoDB,
// overwriting whatever's there for this rosterId. This is how you update
// the roster later — edit the JSON (or generate a new one from an updated
// spreadsheet) and re-run this — without touching any app code or
// redeploying.
//
// Usage:
//   npm run seed:roster                          # uses data/roster-fall-2026.json
//   node scripts/seed-roster.js path/to/other.json

require('dotenv').config();
const mongoose = require('mongoose');
const Roster = require('../models/Roster');
const { ROSTER_ID } = require('../utils/constants');
const { readSeedFile } = require('../utils/rosterSeed');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Add it to your .env file.');
  process.exit(1);
}

const filePath = process.argv[2]; // optional override; defaults to data/roster-fall-2026.json

async function main() {
  const seed = readSeedFile(filePath);
  if (!seed) {
    console.error('Roster file not found:', filePath || '(default: data/roster-fall-2026.json)');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const doc = await Roster.findOneAndUpdate(
    { rosterId: ROSTER_ID },
    { rosterId: ROSTER_ID, captains: seed.captains, players: seed.players },
    { upsert: true, new: true }
  );

  console.log(`Seeded roster "${ROSTER_ID}" from ${seed.filePath}: ${doc.captains.length} captains, ${doc.players.length} players.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

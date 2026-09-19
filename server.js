require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const apiRoutes = require('./routes/api');
const tournamentRoutes = require('./routes/tournament');
const Roster = require('./models/Roster');
const TournamentConfig = require('./models/TournamentConfig');
const { ROSTER_ID } = require('./utils/constants');
const { readSeedFile } = require('./utils/rosterSeed');
const { isValidToken } = require('./utils/tdAuth');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Add it to your .env file (local) or your Render environment variables.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// Make io available to routes
app.set('io', io);

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', apiRoutes);
app.use('/api/tournament', tournamentRoutes);

app.get('/healthz', (req, res) => res.json({ ok: true }));

// The flyer is deliberately NOT in /public \u2014 served through this route
// instead, so it's gated the same way as the rest of the tournament data
// (open once TournamentConfig.revealed is true, TD-only via ?td=<token>
// until then). window.open() can't set custom headers, hence the query
// param instead of the x-td-token header the rest of the API uses.
app.get('/flyer.html', async (req, res) => {
  try {
    const cfg = await TournamentConfig.findOne({ tournamentId: tournamentRoutes.TOURNAMENT_ID }).lean();
    const revealed = !!(cfg && cfg.revealed);
    const authorized = revealed || isValidToken(req.query.td);
    if (!authorized) {
      return res.status(403).send('Not available yet.');
    }
    res.sendFile(path.join(__dirname, 'views', 'flyer.html'));
  } catch (err) {
    console.error('GET /flyer.html error:', err);
    res.status(500).send('Failed to load flyer.');
  }
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Clients join the room for whichever draft they're viewing (the official
  // draft, or their own "sim-<name>" practice sandbox) so state broadcasts
  // stay scoped to that draft instead of reaching every connected client.
  socket.on('join', (draftId) => {
    if (typeof draftId !== 'string' || !draftId) return;
    socket.join(draftId);
  });

  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// If the roster collection is empty (fresh database), seed it from the
// bundled JSON so the app has something to draft on first boot. This never
// overwrites an existing roster — once it's in MongoDB, updates go through
// PUT /api/roster, POST /api/roster/reseed (the Admin screen), or
// scripts/seed-roster.js, not here.
async function seedRosterIfEmpty() {
  const existing = await Roster.findOne({ rosterId: ROSTER_ID }).lean();
  if (existing) return;

  const seed = readSeedFile();
  if (!seed) {
    console.warn('No existing roster and no seed file found — app will boot with an empty roster.');
    return;
  }

  try {
    await Roster.create({ rosterId: ROSTER_ID, captains: seed.captains, players: seed.players });
    console.log(`Seeded roster "${ROSTER_ID}" from ${seed.filePath}: ${seed.captains.length} captains, ${seed.players.length} players.`);
  } catch (err) {
    console.error('Failed to seed roster from', seed.filePath, err);
  }
}

// Same pattern as the roster seed \u2014 only fires if no config exists yet,
// never overwrites live edits (TD flips `revealed` and other fields via
// the Admin screen / API after this).
async function seedTournamentConfigIfEmpty() {
  const existing = await TournamentConfig.findOne({ tournamentId: tournamentRoutes.TOURNAMENT_ID }).lean();
  if (existing) return;

  const seedPath = path.join(__dirname, 'data', 'tournament-fvl-major-oct-2026.json');
  if (!fs.existsSync(seedPath)) {
    console.warn(`No tournament config and no seed file at ${seedPath}.`);
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    await TournamentConfig.create(data);
    console.log(`Seeded tournament config "${data.tournamentId}" from ${seedPath}.`);
  } catch (err) {
    console.error('Failed to seed tournament config from', seedPath, err);
  }
}

mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    console.log('Connected to MongoDB');
    await seedRosterIfEmpty();
    await seedTournamentConfigIfEmpty();
    server.listen(PORT, () => console.log(`FVL Draft server listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

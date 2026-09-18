require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const apiRoutes = require('./routes/api');
const Roster = require('./models/Roster');
const { ROSTER_ID } = require('./utils/constants');
const { readSeedFile } = require('./utils/rosterSeed');

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

app.get('/healthz', (req, res) => res.json({ ok: true }));

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

mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    console.log('Connected to MongoDB');
    await seedRosterIfEmpty();
    server.listen(PORT, () => console.log(`FVL Draft server listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

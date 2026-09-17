require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const apiRoutes = require('./routes/api');

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

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    server.listen(PORT, () => console.log(`FVL Draft server listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

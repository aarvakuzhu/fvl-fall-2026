# FVL Fall 2026 Auction Draft

Live auction-draft board for the Fowler Volleyball League. Started from the
Spring 2026 mock-draft app and converted into a small full-stack app so the
draft state persists in MongoDB and every viewer (director's laptop,
projector, captains on their phones) stays in sync in real time.

- **Backend:** Node.js / Express
- **Persistence:** MongoDB (via `MONGODB_URI`)
- **Live sync:** Socket.io — any change (bid, sale, undo, reset) broadcasts
  to every connected client
- **Frontend:** the original single-page draft board (`public/index.html`),
  unchanged in look and auction logic — only its save/load layer was swapped
  from `localStorage` to the API

## How state persistence works

The client keeps the whole draft (players, teams, round progress, bid
history, undo stack) as one JSON object — the same shape that used to live
in `localStorage`. That blob now round-trips through:

- `GET  /api/state/:draftId` — load the current draft
- `PUT  /api/state/:draftId` — save the draft (debounced ~150ms client-side),
  upserted into a single MongoDB document, then broadcast to other clients
  over Socket.io
- `DELETE /api/state/:draftId` — used by the app's Reset button

`draftId` defaults to `fvl-fall-2026`, so this same codebase can host
another season later by pointing `window.FVL_DRAFT_ID` at a different id (or
just bumping the default) without touching the schema.

The browser also mirrors every save to `localStorage` as an offline
fallback — if the network drops mid-auction, bidding keeps working locally
and re-syncs to MongoDB on the next successful save.

## Fill in the Fall roster

Before running a real draft, edit `public/index.html`:

- `CAPTAIN_NAMES` — the 16 Fall captains
- `CAPTAIN_PICS` — optional headshots per captain
- `TEAM_BUDGETS` — optional per-captain budget overrides (default is `BUDGET`)
- `PLAYER_LIST` — the auction player pool (`name`, `tier`, optional `pic` /
  `skills` / `remarks`)

Each is marked with a `TODO(Fall 2026)` comment in the file.

## Practice mode vs. the official auction

The app opens on a mode-select screen with two paths:

- **🎮 Practice / Simulate** — anyone can enter, no password. They pick their
  name (from the captain dropdown, or type any name) and get their own
  private draft sandbox, stored as its own MongoDB document (`draftId:
  "sim-<slugified-name>"`). It uses the same captains/players/budget config
  as the real thing, so it's a genuine dry run — but it's fully separate
  from the official draft, and picking the same name again later resumes
  exactly where they left off.
- **🔒 Tournament Director** — password-protected (see `TD_PASSWORD` below).
  This is the one official draft (`draftId: "fvl-fall-2026"`). The server
  rejects any write to that draftId without a valid TD session, so only
  the person with the password can actually run the final auction; practice
  sandboxes are always open since they don't touch shared state.

Socket.io broadcasts are scoped per `draftId` (a "room" per draft), so one
captain's practice session never sends updates to anyone else's screen.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | Yes | Atlas connection string |
| `TD_PASSWORD` | No | Tournament Director password. Defaults to `2026` if unset — change this before the real auction. |
| `PORT` | No | Local dev only; Render sets this automatically |



```bash
npm install
cp .env.example .env      # then fill in MONGODB_URI
npm run dev                # or: npm start
```

Visit http://localhost:3000

## Deploy to Render

1. Push this repo to GitHub.
2. In Render, **New → Web Service**, connect the repo (or use the included
   `render.yaml` as a Blueprint).
3. Build command: `npm install` — Start command: `npm start`.
4. Add the `MONGODB_URI` environment variable (an Atlas free-tier cluster
   works fine) in the Render service's Environment tab.
5. Deploy. Render sets `PORT` automatically.

## Project structure

```
server.js            Express app, Mongo connection, Socket.io wiring
models/DraftState.js Mongoose schema (one flexible document per draftId)
routes/api.js         GET / PUT / DELETE /api/state/:draftId
public/index.html      The draft board UI + client-side auction logic
render.yaml            Render Blueprint
.env.example            Env var template
```

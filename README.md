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

## The roster (captains + players)

The roster is **not** hardcoded in `public/index.html` anymore — it lives in
MongoDB (via `GET`/`PUT /api/roster`) so it can be updated anytime without
touching app code or redeploying. `public/index.html` fetches it at load
time and builds `CAPTAIN_NAMES`, `CAPTAIN_TIERS`, `CAPTAIN_PICS`,
`PLAYER_LIST`, and `TEAM_COUNT` from the response.

**First boot:** if the roster collection is empty, `server.js` auto-seeds it
from `data/roster-fall-2026.json` — no manual step needed the first time.

**Updating it later** — pick one:
1. **Admin screen (in the app):** log in as TD, click **⚙ Admin** in the
   header, then **Reseed Roster from Repo File**. This re-reads whatever's
   currently committed at `data/roster-fall-2026.json` in GitHub and
   overwrites the live roster with it — no local setup needed, just push
   the updated JSON to the repo first, then click the button.
2. Edit `data/roster-fall-2026.json` (or generate a new one from an updated
   spreadsheet export), then run `npm run seed:roster` locally (needs
   `MONGODB_URI` in `.env`).
3. `PUT /api/roster` directly with `{ captains: [...], players: [...] }` and
   an `x-td-token` header (obtained from `POST /api/td/auth`).

Whichever path you use, anyone already in the app (captains practicing, the
TD, spectators) needs to **reload the page** to see the change — it isn't
pushed live automatically.

Each person (captain or player) is `{ name, number, tier, pic, skills,
remarks }`. `tier` must be one of the `TIERS` keys in `public/index.html`
(`Mandi` / `Biryani` / `Samosa` / `Chai` / `Biscuit` / `Gatorade`) — pool size per
tier is computed from whatever's actually in the roster, not hardcoded.
`skills` (primary skill) ships blank in the initial import and can be
filled in via either update path above whenever that data's ready.

`TEAM_BUDGETS` (per-captain budget overrides, default is `BUDGET`) is the
one piece still in code, in `public/index.html` — it's a rare manual
exception, not roster data.

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
server.js             Express app, Mongo connection, Socket.io wiring, roster auto-seed on first boot
models/DraftState.js   Mongoose schema for auction state (one flexible document per draftId)
models/Roster.js       Mongoose schema for the roster (captains + players)
routes/api.js          /api/state/:draftId (GET/PUT/DELETE), /api/roster (GET/PUT), /api/td/auth (POST)
utils/tdAuth.js         TD password check + stateless token
utils/constants.js       Shared constants (ROSTER_ID)
utils/rosterSeed.js     Reads/validates the bundled roster JSON (shared by boot seed, the Admin screen, and the CLI script)
scripts/seed-roster.js   Reseed the roster from a JSON file — the CLI path for updating it
data/roster-fall-2026.json  The current roster — captains + players, editable, versioned in Git
public/index.html      The draft board UI + client-side auction logic
render.yaml             Render Blueprint
.env.example             Env var template
```

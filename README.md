# d20 — multiplayer virtual tabletop

A browser-based tabletop for GMs and players: true-to-scale maps, server-enforced secrets (hidden monsters, GM notes, whispers never reach players), live token movement, shared pointers, fog of war, dice and chat. Voice/video stays in Zoom or Teams.

Target: `https://d20.ryangrewell.com` on AWS Amplify. **Not deployed yet.** See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## Quick start (local)

Requirements: Node 22+, Docker.

```bash
npm install
npm run dev:infra      # DynamoDB Local (:8000) + MinIO S3 (:9100)
npm run dev            # API + realtime hub (:8787) and web app (:5173)
npm run seed           # optional: demo campaign, run in a second terminal
```

Open http://localhost:5173. Locally, sign-up verification codes are printed in the API terminal (dev auth emulator; production uses Cognito).

`npm run seed` creates these **local-only** demo accounts (password `d20-demo-pass`):

| Role | Email |
|---|---|
| GM | gm@d20.local |
| Player | player@d20.local |
| Player | player2@d20.local |

To try GM and player side by side, use two different browsers or a private window. Login is stored per browser.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API (tsx watch) + Vite |
| `npm run typecheck` | Strict TypeScript for app, server, scripts and Amplify IaC |
| `npm run lint` | ESLint |
| `npm test` | Unit (shared domain), web, and integration tests. Integration tests run against DynamoDB Local + MinIO and skip if Docker infra is down |
| `npm run e2e` | Playwright journeys (uses local Chrome; starts servers if needed) |
| `npm run build` | Typecheck + production build |
| `npm run lockfile:check` | Confirms `npm ci` accepts the lock file (run after any dependency change; `npm run lockfile:fix` repairs it). npm 11 can write lock files that its own `npm ci` rejects, which fails the Amplify build |

## Layout

```
shared/     Pure, isomorphic domain: units, transforms, calibration, grid, fog, dice,
            permissions, projections, Zod schemas, event/channel contracts
server/     Authoritative API (Hono), command handlers, DynamoDB repo, S3, realtime
            fan-out and channel authorisation. Runs in Lambda and locally.
dev/        Local dev server + Cognito-like dev auth emulator
amplify/    Amplify Gen 2 backend: Cognito, DynamoDB, S3, HTTP API, AppSync Events, alarms
src/        React app (features/*), PixiJS tabletop renderer, sync engine
test/       Integration tests (security negative tests live here)
e2e/        Playwright journeys
scripts/    seed-demo (local), bootstrap-admin (production, one-time)
docs/       Architecture, decisions, security, deployment, API, test plan
```

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

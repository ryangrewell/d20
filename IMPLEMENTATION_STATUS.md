# Implementation status

_Last updated: 2026-10-27_

## Summary

The spec's **first deliverable works locally end to end** and is covered by an automated Playwright journey. That covers sign-up/verify/sign-in, creating a campaign, issuing an invite, a player joining, uploading and calibrating a map, creating a scene and live session, GM and player views in separate browsers, moving a shared token, and seeing synchronized changes and cursors. Deployed to https://d20.ryangrewell.com via Amplify Hosting (us-east-2). Sign-in, the API and realtime (chat, tokens, pointers between two players) are verified live.

## Test results (latest run)

| Check | Result |
|---|---|
| `tsc -b` (app, server, scripts, tests) + `tsc -p amplify` | pass |
| `eslint .` | pass |
| Unit + web tests (25) | pass |
| Integration tests vs DynamoDB Local + MinIO (26) | pass |
| Playwright journeys (2): first deliverable, gameplay | pass |
| `vite build` | pass |
| `cdk synth` of Amplify backend (offline) | pass |

## Backlog status (spec §18)

**Epic A — Accounts & campaigns**
- [x] A01 Scaffold, typed config
- [x] A02 Sign-up / verify / sign-in / reset (Cognito client + local emulator). Cognito path is untested against a live pool.
- [x] A03 Profile + dashboard
- [x] A04 Campaign create/edit/archive
- [x] A05 Hashed, expiring, max-use invites with atomic redemption
- [x] A06 Server-side role checks + test suite

**Epic B — Maps & tabletop**
- [x] B01 Private upload (presigned PUT), magic-byte + dimension validation
- [x] B02 Two-point calibration wizard with unit conversion
- [x] B03 Pan/zoom camera + native-coordinate transform library
- [x] B04 Square/hex/none grid, spacing, origin, rotation, opacity, snapping, moiré suppression
- [x] B05 Ruler + calibration math tests
- [~] B06 Scenes, live-scene switching, and GM token transfer between scenes (`transferSceneObject`) done. Hierarchy/breadcrumbs and portals not built
- [x] B07 Token spawn/move/update/delete with ownership checks
- [~] B08 Shared Display (player projection, no GM UI). Named-player preview exists in the API (`?as=<sub>`) but has no UI

**Epic C — Realtime**
- [x] C01 AppSync Events namespaces + Lambda handlers, verified live on d20.ryangrewell.com (2026-10-27)
- [x] C02 Command handling, revisions, idempotency
- [x] C03 GM / shared / per-user projections
- [x] C04 Realtime token / scene / object updates
- [x] C05 Named, coloured cursors (12 Hz throttle) and pings
- [x] C06 Fog reveal/conceal (rect + brush), persisted ops, reset. S3 checkpoints not built
- [~] C07 Snapshot-based reconnect/resync. `getEventsSince` exists but the client doesn't use it
- [x] C08 Epoch rotation on member removal + negative tests (verified live)

**Epic D — Gameplay** (MPO)
- [x] D01 Declarative, versioned adapter contract + generic-d20 adapter
- [x] D02 Character sheets: owner/GM-only, revisioned, GM edits audited, derived stats, dice buttons, JSON import/export
- [x] D03 Inventory (qty/state/charges/tags, GM-only notes), loot piles with contents, atomic pickup (race-tested)
- [x] D04 Creature library (HP/AC/initiative/notes) and encounter templates (groups placed together, hidden by default), GM-only stats/HP bars
- [x] D05 Server-rolled initiative tracker (hidden combatants stripped for players, round counter, players end their own turn) + conditions on tokens and sheets
- [x] D06 Server-side dice (kh/kl/dh/dl, limits), PUBLIC / GM / SELF, persisted log
- [x] D07 Table chat + whispers (recipient-scoped) with "Load older messages" paging
- [x] Journal & handouts: GM-only / everyone / chosen players, live "shared with you" notice (plain text; images not yet)
- [x] D08 Session lifecycle (plan/start/pause/resume/end) + Zoom/Teams link

**Epic E / F** — Not started, except `scripts/bootstrap-admin.ts` (F02, written but not run) and Amplify infrastructure with alarms and an optional budget (part of F06).

## Active risks

1. ~~AppSync Events contract~~ Verified live on d20.ryangrewell.com (2026-10-27): authorised subscribes, IAM publish of game events, presence re-stamping, and a removed member being cut off (subscribe denial + epoch rotation).
2. **No outbox.** A failed publish after a committed write is only healed on the client's next resync. Planned fix: DynamoDB Streams publisher.
3. **Map images are visible to players** (documented; `strictFog` is future work).
4. Concurrent non-ended sessions on the same scene only notify the session that issued the command.
5. Presence rate limit in Lambda is per container.
6. Cognito default email limits. Configure SES before inviting real groups.

## Next tasks

1. Outbox publisher; GM undo for recent reversible commands; scene checkpoints.
2. Phase 5 interior generator; Phase 6 delegation API/UI, admin dashboard, audit.

## Manual AWS actions required

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): credentials, sandbox deploy, Amplify Hosting app, env vars (`D20_ALLOWED_ORIGINS`, budget email), SES for Cognito, admin bootstrap, and the custom domain (owner approval required).

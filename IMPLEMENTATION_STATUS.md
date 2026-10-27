# Implementation status

_Last updated: 2026-10-26_

## Summary

The spec's **first deliverable works locally end to end** and is covered by an automated Playwright journey. That covers sign-up/verify/sign-in, creating a campaign, issuing an invite, a player joining, uploading and calibrating a map, creating a scene and live session, GM and player views in separate browsers, moving a shared token, and seeing synchronized changes and cursors. Nothing is deployed to AWS. The Amplify backend synthesises but has never been deployed (no credentials).

## Test results (latest run)

| Check | Result |
|---|---|
| `tsc -b` (app, server, scripts, tests) + `tsc -p amplify` | pass |
| `eslint .` | pass |
| Unit tests (19) | pass |
| Integration tests vs DynamoDB Local + MinIO (16) | pass |
| Playwright first-deliverable journey (1) | pass |
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
- [~] C01 AppSync Events namespaces + Lambda handlers defined (synth OK). Live behaviour unverified
- [x] C02 Command handling, revisions, idempotency
- [x] C03 GM / shared / per-user projections
- [x] C04 Realtime token / scene / object updates
- [x] C05 Named, coloured cursors (12 Hz throttle) and pings
- [x] C06 Fog reveal/conceal (rect + brush), persisted ops, reset. S3 checkpoints not built
- [~] C07 Snapshot-based reconnect/resync. `getEventsSince` exists but the client doesn't use it
- [x] C08 Epoch rotation on member removal + negative tests

**Epic D — Gameplay** (MPO)
- [ ] D01 Adapter contract / generic-d20 sheet
- [ ] D02 Character sheets
- [ ] D03 Inventory, drops, atomic pickup
- [~] D04 Spawn hidden/visible creatures, reveal/hide, GM notes. Reusable creature/encounter templates not built
- [ ] D05 Initiative / conditions
- [x] D06 Server-side dice (kh/kl/dh/dl, limits), PUBLIC / GM / SELF, persisted log
- [x] D07 Table chat + whispers (recipient-scoped). No pagination UI for older messages
- [x] D08 Session lifecycle (plan/start/pause/resume/end) + Zoom/Teams link

**Epic E / F** — Not started, except `scripts/bootstrap-admin.ts` (F02, written but not run) and Amplify infrastructure with alarms and an optional budget (part of F06).

## Active risks

1. **AppSync Events handler contract unverified.** `amplify/functions/events/handler.ts` follows AWS docs for direct Lambda handlers but has not run against a live API. First sandbox deploy must test subscribe denial, presence re-stamping, and IAM publish.
2. **No outbox.** A failed publish after a committed write is only healed on the client's next resync. Planned fix: DynamoDB Streams publisher.
3. **Map images are visible to players** (documented; `strictFog` is future work).
4. Concurrent non-ended sessions on the same scene only notify the session that issued the command.
5. Presence rate limit in Lambda is per container.
6. Cognito default email limits. Configure SES before inviting real groups.

## Next tasks

1. Deploy a personal sandbox (`npx ampx sandbox`) and verify Cognito sign-up plus AppSync Events end to end. Fix contract mismatches.
2. Phase 4 completion: generic-d20 adapter + character sheets, inventory and atomic loot pickup, creature library, initiative tracker, chat history pagination.
3. Outbox publisher; GM undo for recent reversible commands; scene checkpoints.
4. Phase 5 interior generator; Phase 6 delegation API/UI, admin dashboard, audit.

## Manual AWS actions required

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): credentials, sandbox deploy, Amplify Hosting app, env vars (`D20_ALLOWED_ORIGINS`, budget email), SES for Cognito, admin bootstrap, and the custom domain (owner approval required).

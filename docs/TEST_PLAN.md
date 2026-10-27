# Test plan

| Layer | Location | Runs | Covers |
|---|---|---|---|
| Unit | `shared/**/*.test.ts` | `npm test` | Units, transforms, calibration math (mile and 5-ft cases), grid density/snapping (square, hex), dice parser/roller/limits, fog evaluation, channel parsing, image sniffing, visibility projection, delegation scopes |
| Integration | `test/integration/` | `npm test` (needs `npm run dev:infra`) | Real DynamoDB Local + MinIO through the HTTP app: character sheet privacy/revisions/GM audit, inventory, import/export, atomic loot pickup race (negative test 10), creature-stat privacy, initiative projection and turn permissions, encounter placement (hidden, numbered), journal privacy and reader-only notices, chat paging without whisper leaks, invites (concurrency, revocation), upload validation, calibration, projections, negative security tests 1–6, 8, 9, epoch rotation, idempotency, fog visibility, whispers, dice, persistence across sessions (J5) |
| E2E | `e2e/` | `npm run e2e` | Gameplay: sheet + attack dice to chat, loot pickup into inventory, creature spawn, initiative with hidden combatant stripped for players, encounter placement from GM tools, sharing a handout that notifies the player. First deliverable: UI sign-up, campaign, invite, join, upload, calibrate, scene, live session, two browsers, hidden monster privacy, token drag sync, shared cursors, reload persistence |

## Spec journeys

| Journey | Status |
|---|---|
| J1 private admission | Automated (integration + E2E) |
| J2 city → interior scale | Math automated (unit). UI calibration covered for one map in E2E. Second-map UI flow is manual |
| J3 live tabletop | Automated (integration + E2E) except a 3-player run |
| J4 whispers & loot | Automated: whisper privacy, and a two-player race for the last loot item (exactly one wins) |
| J5 resume next week | Automated (integration) |
| J6 delegation | Resolution logic unit-tested; API/UI not built |
| J7 moderation | Not built |
| J8 interior generator | Not built |

Not yet done: load test with 1 GM + 5 players, p95 latency measurement, 4096² map performance check, accessibility audit.

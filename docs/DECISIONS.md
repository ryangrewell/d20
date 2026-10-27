# Decisions

**D-001 — Local-first development with real AWS-compatible services.** No AWS credentials were available while building. Local dev uses DynamoDB Local and MinIO (S3 API) via docker compose. The same server code runs in Lambda. A dev auth emulator mints HS256 tokens and is refused at startup in production or Lambda.

**D-002 — HTTP API + Lambda (Hono) instead of Amplify Data CRUD.** One consistent command/query layer with explicit server-side authorisation. No generated CRUD is exposed for campaign tables. The Lambda verifies Cognito ID tokens itself (jose + JWKS) and re-checks account status in DynamoDB on every request.

**D-003 — Single DynamoDB table.** Access patterns are all entity-scoped (see ARCHITECTURE.md), and transactions span entity types (invite + member, object + event + idempotency record).

**D-004 — Per-viewer durable channels.** Rather than a shared player channel plus private overlays, every member gets a `user/{sub}` stream with their exact projection. This costs O(members) publishes per command, which is fine at table sizes (≤ ~10). It removes cross-channel ordering hazards. The `shared` channel exists for the Shared Display.

**D-005 — Imperative PixiJS renderer.** The tabletop renderer is a plain class driven by store subscriptions, not `@pixi/react`. This gives precise control over redraw frequency (grid, fog texture updates, label scaling) and keeps React out of per-frame work. `pixi.js/unsafe-eval` is imported so a strict CSP (no `unsafe-eval`) works.

**D-006 — Token move concurrency by object revision, not session revision.** The command envelope's `expectedRevision` is per object (`expectedObjectRevision`). Session-level optimistic concurrency would make concurrent players conflict constantly. Session revisions are still monotonic and stamped on every event.

**D-007 — Revisions allocated before the write transaction.** The session revision is bumped with an atomic counter, then the state/event/idempotency transaction runs. A failed transaction leaves a gap, which is harmless because revisions are monotonic, not contiguous.

**D-008 — Inline publish (no outbox yet).** Events are persisted in the same transaction as the state change and published right after. If a publish fails, connected clients recover on their next resync (reconnect, scene/status change, conflict). Backlog: DynamoDB Streams–driven publisher for guaranteed delivery.

**D-009 — Fog as operations, evaluated on both sides.** Small, append-only, easy to sync and audit. The client rasterises at ≤2048 px. Reset deletes the operations. Large-history checkpoints to S3 are backlog (limit: 5000 ops/scene).

**D-010 — Tokens behind fog are omitted for players.** Stronger than client-side hiding. PCs and player-controlled tokens stay visible under fog.

**D-011 — Dice use `crypto.randomInt` server-side.** Rolls are chat messages of kind `ROLL` with visibility PUBLIC / GM / SELF.

**D-012 — Invite tokens.** 24 random bytes (base64url), only SHA-256 stored. A raw token is shown once. Redemption is a DynamoDB transaction: conditional use-count increment plus member put.

**D-013 — TypeScript 6.0.** TS 7 is available, but typescript-eslint supports `<6.1`.

**D-014 — Players see "waiting" until a session is LIVE/PAUSED.** GMs can prep in PLANNED sessions. Scene state lives on scenes (not sessions), so it persists across sessions. A new session inherits the previous session's active scene.

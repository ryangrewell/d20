# Decisions

**D-001 — Local-first development with real AWS-compatible services.** No AWS credentials were available while building. Local dev uses DynamoDB Local and MinIO (S3 API) via docker compose. The same server code runs in Lambda. A dev auth emulator mints HS256 tokens and is refused at startup in production or Lambda.

**D-002 — HTTP API + Lambda (Hono) instead of Amplify Data CRUD.** One consistent command/query layer with explicit server-side authorisation. No generated CRUD is exposed for campaign tables. The Lambda verifies Cognito ID tokens itself (jose + JWKS) and re-checks account status in DynamoDB on every request.

**D-003 — Single DynamoDB table.** Access patterns are all entity-scoped (see ARCHITECTURE.md), and transactions span entity types (invite + member, object + event + idempotency record).

**D-004 — Per-viewer durable channels.** Rather than a shared player channel plus private overlays, every member gets a `user/{sub}` stream with their exact projection. This costs O(members) publishes per command, which is fine at table sizes (≤ ~10). It removes cross-channel ordering hazards. The `shared` channel exists for the Shared Display.

**D-005 — Imperative PixiJS renderer.** The tabletop renderer is a plain class driven by store subscriptions, not `@pixi/react`. This gives precise control over redraw frequency (grid, fog texture updates, label scaling) and keeps React out of per-frame work. `pixi.js/unsafe-eval` is imported so a strict CSP (no `unsafe-eval`) works.

**D-006 — Token move concurrency by object revision, not session revision.** The command envelope's `expectedRevision` is per object (`expectedObjectRevision`). Session-level optimistic concurrency would make concurrent players conflict constantly. Session revisions are still monotonic and stamped on every event.

**D-007 — Revisions allocated before the write transaction.** The session revision is bumped with an atomic counter, then the state/event/idempotency transaction runs. A failed transaction leaves a gap, which is harmless because revisions are monotonic, not contiguous.

**D-008 — Inline publish + pull-based catch-up (instead of a stream-driven outbox).** Events are persisted in the same transaction as the state change, published right away, and retried once. Every non-display client also reconciles against its own per-viewer event log every 20 s and when the tab regains focus (`GET /sessions/:sid/events?since=`), applying anything not yet seen by event id. A lost publish therefore shows up within ~20 s with no extra infrastructure. The scan re-reads a 25-revision window, because revisions are allocated before their write lands (D-007). A DynamoDB Streams publisher remains an option if push latency on failure ever matters.

**D-009 — Fog as operations, evaluated on both sides.** Small, append-only, easy to sync and audit. The client rasterises at ≤2048 px. Reset deletes the operations. Large-history checkpoints to S3 are backlog (limit: 5000 ops/scene).

**D-010 — Tokens behind fog are omitted for players.** Stronger than client-side hiding. PCs and player-controlled tokens stay visible under fog.

**D-011 — Dice use `crypto.randomInt` server-side.** Rolls are chat messages of kind `ROLL` with visibility PUBLIC / GM / SELF.

**D-012 — Invite tokens.** 24 random bytes (base64url), only SHA-256 stored. A raw token is shown once. Redemption is a DynamoDB transaction: conditional use-count increment plus member put.

**D-013 — TypeScript 6.0.** TS 7 is available, but typescript-eslint supports `<6.1`.

**D-014 — Players see "waiting" until a session is LIVE/PAUSED.** GMs can prep in PLANNED sessions. Scene state lives on scenes (not sessions), so it persists across sessions. A new session inherits the previous session's active scene.

**D-015 — GM undo is state-checked, per GM, and scoped to map commands.** Undoable commands (move/place/edit/remove/transfer token, place encounter, fog brush) store an inverse record (object states before/after, fog op seq) in the same transaction, TTL 24 h. `undoLast` reverts the GM's own latest record only if each object still has the exact state that command produced (ignoring revision/timestamps), so it never overwrites a later change by a player. Undo IDs use a monotonic ULID so same-millisecond records keep order. Not undoable: fog reset, scene switch, chat/dice, initiative, loot pickup.

**D-016 — Checkpoints live in S3; restore is batched, not atomic.** A checkpoint is a JSON snapshot (tokens + fog ops) in S3 with a small DynamoDB index row, max 50 per scene. Restore replaces the scene via batch writes (DynamoDB transactions cap at 100 items), then emits `SCENE_REFRESH` so clients refetch. A failure part-way leaves a mix that re-running the restore repairs. Restored objects get revisions above anything clients hold.

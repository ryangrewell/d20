# Architecture

```text
Browser (React + PixiJS)
  ├─ Cognito (auth)                       dev: dev/auth.ts emulator (HS256 JWTs)
  ├─ HTTPS API  /api/*  → Lambda (Hono)   dev: same Hono app on :8787
  │      └─ DynamoDB (single table) + S3 (private media)
  │      └─ publishes audience-filtered events (IAM) → AppSync Events
  └─ AppSync Events WebSocket             dev: server/realtime/localHub.ts
         namespaces: game (server-published), presence (client cursors)
         onSubscribe/onPublish → Lambda → server/realtime/authorize.ts
```

## Principles

1. **Server-authoritative.** Clients send commands (`POST /api/commands`); the server validates (Zod), authorises against database state, persists, then broadcasts. Identity comes only from the verified token. Role claims in requests or packets are ignored.
2. **Projections, not hiding.** Every snapshot and event goes through `shared/projection.ts`. Players never receive GM-only objects, GM notes, objects under fog, other scenes, or whispers they aren't party to.
3. **One stream per viewer.** Each accepted command produces one event per audience: `gm`, `shared` (Shared Display), and `user/{sub}` per member. Players subscribe only to their own user channel, so cross-channel ordering can't leak or reorder visibility.
4. **Ephemeral vs durable.** Cursors/pings go over `presence`, aren't stored, and are validated and re-stamped with the sender's server-known identity. Token moves, fog, chat and dice are durable commands.

## Coordinates and scale

`shared/geometry/transform.ts` is the single transform module. Everything persisted uses **native image pixels**. The camera (`x, y, zoom`) only affects drawing. Calibration stores `pixelsPerMeter` from two native-pixel points and a real distance, so measurements never depend on zoom, window size or device. Cursors travel as normalised 0–1 map coordinates.

## Fog

Fog is an ordered list of reveal/conceal operations over an initial state (`shared/fog.ts`). The renderer rasterises it to a canvas texture. The server evaluates the same operations to decide which tokens are "behind fog" and therefore omitted for players. Party tokens (PC or player-controlled) remain visible under fog. Uploaded map images themselves are not protected by fog (see SECURITY.md).

Fog automation adds two layers to `FogState`, evaluated in this order by both the server and the renderer (`isFogged`): the initial state, then the **explored** layer (a ≤512-cell bit grid of area revealed automatically: rooms a party token walked into, and remembered torchlight), then the GM's own ops (last wins), then current **lights** (polygons from visible party tokens' `lightRadiusMeters`, clipped by walls), which show through everything. Walls and rooms live on the map (`MapDefinition.walls`; generated maps derive them from the floorplan), the torchlight mode and room reveal on the scene (`Scene.lighting`). Commands that move or change party tokens recompute the layers and emit a `fogLayers` change; the fan-out sends `FOG_LAYERS` plus add/remove for tokens whose visibility flipped. The explored layer is stored at `SCENE#id / EXPLORED` with a version; racing writers re-run once. GM fog undo only depends on the GM's own ops, so automatic reveals never block it.

## Sync and recovery (`src/features/tabletop/sync.ts`)

1. Fetch snapshot to learn authorised channels and the access epoch.
2. Subscribe while buffering events.
3. Fetch the authoritative snapshot (revision N); apply buffered events with revision > N, deduplicated by event id.
4. Repeat on reconnect, scene change, session status change, `ACCESS_CHANGED`, or a write conflict.

Revisions are monotonic per session but not contiguous for a given audience. Recovery relies on snapshots, not gap detection. In addition, every 20 s (and on tab focus) a client pulls its own event log since its last snapshot and applies anything it missed, so a lost live update is healed without a reload (DECISIONS D-008). `SCENE_REFRESH` (fog undo, checkpoint restore) makes viewers refetch the snapshot.

## Access epochs

Channel paths include `accessEpoch`. Removing a member (and, later, revoking a delegation or blocking a user) increments the epoch on all non-ended sessions, notifies the old channels, and the server stops publishing to them. Subscribing to a stale epoch is rejected, so revoked users stop receiving broadcasts even if their WebSocket stays open.

## DynamoDB single-table layout

| Entity | PK | SK | GSI1PK / GSI1SK |
|---|---|---|---|
| Profile | `USER#sub` | `PROFILE` | `USERS` / `createdAt#sub` |
| Campaign | `CAMP#id` | `META` | |
| Member | `CAMP#id` | `MEMBER#sub` | `USER#sub` / `CAMP#id` |
| Invite | `CAMP#id` | `INVITE#id` | `INVITEHASH#sha256` / `INVITE` |
| Delegation | `CAMP#id` | `DELEG#id` | |
| Map asset / definition | `CAMP#id` | `ASSET#id` / `MAP#id` | |
| Session | `SESSION#id` | `META` | `CAMP#id` / `SESSION#number` |
| Session event | `SESSION#id` | `EVT#revision` (TTL) | |
| Command idempotency | `SESSION#id` | `CMD#commandId` (TTL 24h) | |
| GM undo record | `SESSION#id` | `UNDO#monotonic-ulid` (TTL 24h) | |
| Scene checkpoint index | `SCENE#id` | `CHECKPOINT#id` (snapshot JSON in S3) | |
| Scene | `SCENE#id` | `META` | `CAMP#id` / `SCENE#id` |
| Scene object | `SCENE#id` | `OBJ#id` | `OBJ#id` / `OBJ` |
| Fog op | `SCENE#id` | `FOG#seq` | |
| Explored layer | `SCENE#id` | `EXPLORED` | encoded grid + version |
| Character | `CAMP#id` | `CHAR#id` | |
| Inventory item / GM-edit audit | `CHAR#id` | `ITEM#id` / `AUDIT#ulid` | |
| Creature / encounter template | `CAMP#id` | `CREATURE#id` / `ENCOUNTER#id` | |
| Journal entry | `CAMP#id` | `JOURNAL#id` | |
| Generated floorplan | `CAMP#id` | `FLOORPLAN#id` (input + seed, names, floor→map/scene) | |
| Chat / roll | `CHAT#campaignId` | `MSG#ulid` | |
| Audit event (append-only) | `AUDIT` | `at#ulid` | `AUDIT#type#id` / `at#ulid` |
| Report | `REPORT` | `REPORT#ulid` | |
| Rate window | `RATE#bucket` | `W#window` (TTL) | |

No query scans across campaigns. Conditional writes and transactions cover invite redemption, object revisions (including loot pickup), character revisions, initiative version, fog sequence, and command idempotency.

Initiative lives on the session item. Character sheets are campaign-level and private to owner + GM; changes publish an id-only `CHARACTER_UPDATED` to the owner's and GM's channels, and clients refetch.

## Frontend

- `src/app` routing/providers, `src/features/*` per area, `src/components/ui` primitives.
- Map setup (calibration) uses DOM + SVG through the same transform module.
- The tabletop uses an imperative PixiJS renderer class (`renderer/TabletopRenderer.ts`), not `@pixi/react`. See DECISIONS D-005.

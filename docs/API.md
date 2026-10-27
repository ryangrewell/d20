# API

All routes are under `/api`. They need `Authorization: Bearer <Cognito ID token>`, except `/api/health` and the local-only `/api/dev/*`. Errors use the shape `{ "error": { "code", "message", "details?" } }` with codes `UNAUTHENTICATED | FORBIDDEN | NOT_FOUND | CONFLICT | INVALID_INPUT | RATE_LIMITED | INTERNAL`. Input schemas live in `shared/schemas/`.

| Method | Path | Notes |
|---|---|---|
| GET/PATCH | `/me` | Profile; PATCH `{ displayName }` |
| GET/POST | `/campaigns` | List mine / create (caller becomes owner) |
| GET/PATCH | `/campaigns/:cid` | Dashboard (members, sessions; maps/scenes for GM) / update (owner) |
| POST | `/campaigns/:cid/archive` | Owner |
| DELETE | `/campaigns/:cid/members/:sub` | Owner; rotates access epochs |
| GET/POST | `/campaigns/:cid/invites` | Owner; POST returns the raw token once |
| POST | `/campaigns/:cid/invites/:iid/revoke` | Owner |
| POST | `/invites/preview`, `/invites/accept` | `{ token }`; rate limited |
| POST | `/campaigns/:cid/sessions` | GM; new PLANNED session |
| POST | `/sessions/:sid/transition` | GM; `{ action: start\|pause\|resume\|end }` |
| PATCH | `/sessions/:sid` | GM; title, meetingUrl, gmNotes |
| GET | `/sessions/:sid/snapshot[?as=shared\|<sub>][&scene=<id>]` | Projected snapshot; `as`/`scene` GM-only |
| GET | `/sessions/:sid/events?since=N` | Caller-projected events after revision N |
| POST | `/commands` | Game command envelope (below) |
| POST | `/campaigns/:cid/maps/upload-intent` | GM; returns presigned PUT (5 min) |
| POST | `/campaigns/:cid/maps` | GM; finalize: sniff signature/dimensions, create map |
| GET/PATCH | `/campaigns/:cid/maps/:mid` | GM; calibration + grid |
| POST/PATCH | `/campaigns/:cid/scenes[/:scid]` | GM |
| GET/POST | `/campaigns/:cid/characters` | List (own sheets in full, others by name only; GM sees all) / create (GM may set `ownerSub`) |
| POST | `/campaigns/:cid/characters/import` | `{ data: <d20.character v1 export>, ownerSub? }` |
| GET/PATCH/DELETE | `/campaigns/:cid/characters/:chid` | Owner or GM. PATCH needs `expectedRevision`; `gmNotes`/`ownerSub` GM-only; GM edits are audited |
| GET | `/campaigns/:cid/characters/:chid/export` | Platform JSON (`format: d20.character`, `version: 1`) without GM notes |
| POST/PATCH/DELETE | `/campaigns/:cid/characters/:chid/items[/:iid]` | Inventory; owner or GM; `gmNote` GM-only |
| GET/POST/PATCH/DELETE | `/campaigns/:cid/creatures[/:crid]` | GM-only creature library |
| GET/POST/PATCH/DELETE | `/campaigns/:cid/encounters[/:eid]` | GM-only encounter templates (`groups: [{ creatureId, count }]`, ≤30 creatures) |
| POST | `/campaigns/:cid/quick-encounters` | GM-only. Saves new creatures and an encounter in one transaction. Each group is `{ count, creatureId }` (reuse) or `{ count, creature }` (new); ≤20 enemies, ≤4 groups. Stats come from the client, scaled from `settings.enemyBaseline` |
| GET/POST/PATCH/DELETE | `/campaigns/:cid/journal[/:jid]` | List returns only readable entries; writes GM-only. `visibility: GM_ONLY\|ALL\|SELECTED_PLAYERS` |
| GET/POST | `/campaigns/:cid/delegations` | Owner grants `{ delegateSub, scope: SESSIONS\|NEXT_N_SESSIONS\|TIME_WINDOW, permissions }`; list (owner: all, delegate: own) |
| POST | `/campaigns/:cid/delegations/:did/revoke` | Owner; rotates access epochs |
| POST | `/reports` | Member reports a USER / MESSAGE / CAMPAIGN in their campaign (only content they can see); 10/hour |
| GET | `/me/admin` | Live platform-admin check |
| GET | `/admin/metrics`, `/admin/users?q=`, `/admin/users/:sub`, `/admin/campaigns`, `/admin/reports?status=`, `/admin/audit?before=` | Live admin check on every call |
| POST | `/admin/users/:sub/{suspend\|block\|unblock\|revoke-admin}` | `{ reason, until? }`; audited; block disables sign-in; last admin can't be revoked |
| POST | `/admin/campaigns/:cid/members/:sub/remove`, `/admin/reports/:rid/resolve` | Audited moderation |
| GET/POST | `/campaigns/:cid/floorplans` | GM; POST `{ input, roomNames, showLabels, fogInitial, floors: [{ level, assetId }] }`. Server regenerates and validates, checks image proportions, creates calibrated maps, scenes and stair portal pins |
| GET/POST | `/campaigns/:cid/scenes/:scid/checkpoints` | GM; save `{ label }` / list newest first |
| DELETE | `/campaigns/:cid/scenes/:scid/checkpoints/:cpid` | GM |
| GET | `/campaigns/:cid/chat?before=<msgId>&limit=N` | Older chat (oldest-first page + `hasMore`), whispers filtered by recipient |

## Commands

```json
{ "commandId": "<uuid>", "sessionId": "<ulid>", "type": "moveToken", "payload": { "objectId": "…", "x": 1452.5, "y": 608.25 } }
→ { "ok": true, "commandId": "…", "newRevision": 28, "serverTime": "…", "result": { … } }
```

| Type | Who | Payload |
|---|---|---|
| `moveToken` | GM, or the token's controller | `objectId, x, y, expectedObjectRevision?` |
| `spawnSceneObject` | GM | `sceneId, objectType, x, y, label?, tint?, sizeMeters?, visibility, allowedViewerIds?, assignedControllerSub?, gmNotes?, templateId?, characterId?, loot?, portal?` |
| `updateSceneObject` | GM | `objectId, patch{ label, tint, …, conditions, loot, gmStats, characterId, portal }` |
| `removeSceneObject` | GM | `objectId` |
| `transferSceneObject` | GM | `objectId, targetSceneId, x?, y?` (defaults to the target map's centre; keeps id, controller, appearance) |
| `updateFog` | GM | `sceneId, op{ mode, shape: rect\|polygon\|brush }` |
| `resetFog` | GM | `sceneId, initial` |
| `switchActiveScene` | GM | `sceneId` |
| `presenterFocus` | GM | `sceneId, center, zoom` |
| `spawnEncounter` | GM | `encounterId, sceneId, x, y, visibility` (default hidden); numbered copies in a grid around the point |
| `undoLast` | GM | `{}`; reverts this GM's latest undoable map command if nothing changed since |
| `restoreCheckpoint` | GM | `sceneId, checkpointId` |
| `pickupLoot` | member (own character) or GM | `objectId, entryId, characterId, quantity`; atomic, one winner per item |
| `rollInitiative` | GM, or a player for their own tokens | `objectIds[]`; server rolls 1d20 + modifier from sheet or creature stats |
| `setInitiativeEntry` / `removeInitiativeEntry` | GM | manual combatants |
| `advanceTurn` | GM, or the player whose turn it is (`next` only) | `direction: next\|prev` |
| `endCombat` | GM | `{}` |
| `sendChat` | member | `body, recipientSubs?` (whisper) |
| `rollDice` | member | `expression, label?, visibility: PUBLIC\|GM\|SELF` |

## Realtime channels

`/game/{sessionId}/{epoch}/gm`, `/game/{sessionId}/{epoch}/shared`, `/game/{sessionId}/{epoch}/user/{sub}` are server-published. `/presence/{sessionId}/{epoch}` takes client cursor publishes, which are validated and identity-stamped. Event shapes are in `shared/events.ts`.

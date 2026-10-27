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

## Commands

```json
{ "commandId": "<uuid>", "sessionId": "<ulid>", "type": "moveToken", "payload": { "objectId": "…", "x": 1452.5, "y": 608.25 } }
→ { "ok": true, "commandId": "…", "newRevision": 28, "serverTime": "…", "result": { … } }
```

| Type | Who | Payload |
|---|---|---|
| `moveToken` | GM, or the token's controller | `objectId, x, y, expectedObjectRevision?` |
| `spawnSceneObject` | GM | `sceneId, objectType, x, y, label?, tint?, sizeMeters?, visibility, allowedViewerIds?, assignedControllerSub?, gmNotes?` |
| `updateSceneObject` | GM | `objectId, patch{…}` |
| `removeSceneObject` | GM | `objectId` |
| `updateFog` | GM | `sceneId, op{ mode, shape: rect\|polygon\|brush }` |
| `resetFog` | GM | `sceneId, initial` |
| `switchActiveScene` | GM | `sceneId` |
| `presenterFocus` | GM | `sceneId, center, zoom` |
| `sendChat` | member | `body, recipientSubs?` (whisper) |
| `rollDice` | member | `expression, label?, visibility: PUBLIC\|GM\|SELF` |

## Realtime channels

`/game/{sessionId}/{epoch}/gm`, `/game/{sessionId}/{epoch}/shared`, `/game/{sessionId}/{epoch}/user/{sub}` are server-published. `/presence/{sessionId}/{epoch}` takes client cursor publishes, which are validated and identity-stamped. Event shapes are in `shared/events.ts`.

# Security model

## Enforced server-side (tested in `test/integration/api.test.ts`)

| Threat | Control | Test |
|---|---|---|
| Non-member reads campaign | `loadCampaign` returns NOT_FOUND (no existence leak) | J1 |
| Player runs GM command | Per-command `requireGM` | negative 1 |
| Guessing hidden object id | Visibility check before any action; NOT_FOUND | negative 2 |
| Cross-campaign channel subscribe | `authorizeChannel`: session → campaign membership | negative 3 |
| Spoofed identity in cursor packet | `sanitizePresence` discards body identity, stamps member identity | negative 4 |
| Upload into another campaign | Server-chosen S3 key under `campaigns/{id}/`, GM check | negative 5 |
| Reading others' whispers | Recipient-filtered queries and per-user channels | negative 6, J4 |
| Blocked user with valid JWT | Profile status checked on every request and subscribe | negative 8 |
| Invite over-redemption | Conditional transaction | negative 9 |
| Removed member keeps stream | Access-epoch rotation | epoch test |
| Duplicate command retries | `commandId` idempotency records | idempotency test |
| Disguised upload (e.g. SVG as PNG) | Magic-byte sniffing + dimension limits on finalize | upload test |
| Dice abuse | Parser limits (≤200 dice, ≤1000 sides, ≤120 chars) | unit |

Rate limits: invite create/preview/accept, uploads, chat (40/min), dice (60/min) via DynamoDB windows. Presence uses a token bucket (per container in Lambda).

## Known limitations (v1)

- **Map imagery is not fog-protected.** A player can download the full image of the active scene's map. Do not put spoilers in images you intend to fog. A future `strictFog` mode would serve per-player pre-obscured tiles.
- Presence rate limiting in Lambda is per warm container, not global.
- Cognito tokens are stored by Amplify in localStorage by default. Consider cookie storage plus a CSP review before launch.
- Admin dashboard, moderation, reports and audit log are not built yet. The bootstrap script exists.
- The AppSync Events Lambda handler request/response shape follows AWS docs but **has not been exercised against a live API**. Verify in a sandbox deploy before launch.

## Logging

Structured JSON logs. Never log tokens, presigned URLs, or message bodies. Event publish failures log the channel prefix only.

## Headers

`amplify.yml` sets HSTS, nosniff, frame-deny, referrer policy, permissions policy, and a CSP without `unsafe-eval`.

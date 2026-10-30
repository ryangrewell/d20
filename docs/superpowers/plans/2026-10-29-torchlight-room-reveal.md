# Torchlight and Room Reveal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Party tokens clear fog with a GM-set light radius, in "remember" or "live" mode, and whole rooms reveal when a party token enters them. Generated maps use their own walls; uploaded maps get a GM walls and rooms editor.

**Architecture:**
- **Shared code:** the existing `FogState` grows two optional layers: `explored`, a bounded bit grid of auto-revealed area, and `lights`, the current light polygons. Server projection and client renderer use the same `isFogged`.
- **Where data lives:** walls and rooms live on the map, the lighting settings on the scene, and the light radius on the token.
- **Server work:** the server computes lights and explored cells inside the command handlers that move or change party tokens. It emits a new `fogLayers` change, and the fan-out turns that into a `FOG_LAYERS` event plus add/remove events for tokens whose visibility flipped, the same way GM fog edits work today.

**Tech Stack:** TypeScript 6, React 19, PixiJS 8, Hono, DynamoDB (single table), Zod 4, Vitest, Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-29-torchlight-room-reveal-design.md`

## Global Constraints

- **Server decides visibility:** players' visibility is decided on the server. Light from GM_ONLY or SELECTED_PLAYERS tokens and from non-party tokens never counts.
- **Who can carry light:** only party tokens (`objectType === 'PC'` or `assignedControllerSub` set) can carry light. The server rejects `lightRadiusMeters` on other tokens with 400.
- **Light is GM-set only:** nothing on character sheets or in inventories.
- **Evaluation order for players:** initial state, then the explored layer (reveal), then GM fog ops (last wins), then current lights (reveal, overriding everything).
- **GM fog Undo:** it only depends on `scene.fogOpCount`. Automatic reveals never change it.
- **Reset fog** clears the explored layer. Undoing a move never removes explored area.
- **Calibration:** light needs a calibrated map. Rooms and walls work in map pixels with or without calibration.
- **Repo rules:** strict TypeScript, Zod for every new input, docs updated, and each task committed locally. Do not push.

## Review Focus

1. **Event size on a big map:** on a 4096 × 4096 map with a large explored area, `FOG_LAYERS` and snapshot payloads must stay small, because each event is stored for every audience in one DynamoDB item (400 KB limit). Test: an encoded 512 × 512 grid holding one big blob stays under 8 KB (Task 2).
2. **Hidden light-bearer:** a PC token switched to GM_ONLY mid-session stops lighting for players at once. Players lose any area only its light showed. Test in Task 4.
3. **Uncalibrated map:** setting a light radius is rejected with a clear message, and room reveal still works. Test in Task 4.
4. **Token on a shared wall or doorway line:** a token standing exactly on an edge two rooms share reveals both rooms and doesn't throw. Test in Task 1 (`roomsContaining`).
5. **Concurrent moves:** two players moving lit tokens at the same instant in remember mode must both succeed, because the explored write retries once on a version conflict. Test in Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/lighting/walls.ts` (new) | Wall and room types, `wallSegments`, `roomsContaining`, `floorplanToWalls` |
| `shared/lighting/light.ts` (new) | `lightPolygon` (visibility polygon clipped by walls), `partyLights` |
| `shared/lighting/explored.ts` (new) | Bounded explored bit grid: create, mark polygon, contains, encode/decode |
| `shared/fog.ts` | `FogState.explored?` and `FogState.lights?`; `isFogged` precedence |
| `shared/model.ts`, `shared/schemas/*.ts`, `shared/events.ts` | New fields, inputs, the `setSceneLighting` command and the `FOG_LAYERS` event |
| `server/services/lighting.ts` (new) | Loads the explored record, computes layers, and builds the `fogLayers` change and explored write |
| `server/services/sessions.ts` (`loadFog`), `server/realtime/fanout.ts`, `server/services/commands.ts`, `server/services/undo.ts`, `server/services/checkpoints.ts`, `server/services/maps.ts`, `server/services/floorplans.ts` | Wiring |
| `src/features/tabletop/sync.ts`, `store.ts`, `renderer/TabletopRenderer.ts` | Client layers and drawing |
| `src/features/tabletop/panels/GMPanel.tsx` | Lighting controls and the token light radius |
| `src/features/maps/WallsEditor.tsx` (new), `MapSetupPage.tsx` | Walls and rooms editor |
| `test/integration/lighting.test.ts` (new), `e2e/lighting.spec.ts` (new) | Tests |

---

### Task 1: Walls and rooms geometry

**Files:**
- Create: `shared/lighting/walls.ts`
- Test: `shared/lighting/walls.test.ts`

**Interfaces:**
- **Produces:**
  - `type Segment = { a: Point; b: Point }`
  - `type WallRoom = { id: string; name?: string; points: Point[] }` (polygon in map px, 3 to 200 points)
  - `type MapWalls = { rooms: WallRoom[]; doorways: Segment[] }`
  - `wallSegments(walls: MapWalls): Segment[]`: every room polygon edge, minus any doorway segment collinear with it within 2 px and overlapping it. An edge shared by two rooms appears once.
  - `roomsContaining(walls: MapWalls, p: Point): WallRoom[]`: point-in-polygon, with points on an edge (within 0.5 px) counting as inside.
  - `floorplanToWalls(floor: Floor, pxPerMeter: number): MapWalls`
    - Rooms of every kind (room, hall, stairs) become 4-point rectangles with id = `room.id` and name = `room.name`.
    - Each door becomes a doorway: horizontal `{x−w/2, y}` to `{x+w/2, y}`, vertical `{x, y−w/2}` to `{x, y+w/2}`, all multiplied by pxPerMeter.
    - Windows are walls, so they produce no doorway.

- [ ] **Step 1: Write the failing tests**
  - `wallSegments: doorway splits an edge`: one 100 × 100 room at (0,0) with doorway (40,0) to (60,0). The top edge yields (0,0)–(40,0) and (60,0)–(100,0); there are 5 segments in total.
  - `wallSegments: shared edge appears once`: two adjacent rooms (0,0,100,100) and (100,0,100,100) give 7 segments.
  - `roomsContaining`: the point (100,50) returns both rooms; (50,50) returns the first only; (500,500) returns `[]`.
  - `floorplanToWalls`: generate the floorplan for `{name:'T', buildingType:'tavern', width:60, depth:40, unit:'ft', floors:1, basement:false, density:'normal', theme:'medieval', seed:'walls'}` with pxPerMeter 10. Expect rooms.length === floor.rooms.length, doorways.length === floor.doors.length, and every room point inside [0, widthM*10] × [0, depthM*10].
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run shared/lighting/walls.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `shared/lighting/walls.ts`.** Reuse the point-in-polygon logic from `shared/fog.ts` by exporting `pointInPolygon` from there; don't copy it.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `npx vitest run shared/lighting/walls.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lighting): wall and room geometry`

### Task 2: Light polygons, explored grid, fog precedence

**Files:**
- Create: `shared/lighting/light.ts`, `shared/lighting/explored.ts`
- Modify: `shared/fog.ts`
- Test: `shared/lighting/light.test.ts`, `shared/lighting/explored.test.ts`, `shared/domain.test.ts` (fog precedence)

**Interfaces:**
- **Consumes:** `Segment`, `MapWalls`, `wallSegments` (Task 1).
- **Produces:**
  - `lightPolygon(origin: Point, radiusPx: number, walls: Segment[]): Point[]`
    - Cast rays at 96 even angles plus each wall endpoint within the radius at ±0.0001 rad.
    - Each ray stops at the nearest wall hit or at the radius. Results are sorted by angle and capped at 200 points.
  - `isPartyToken(o: Pick<SceneObject,'objectType'|'assignedControllerSub'>): boolean`. Also replace the inline check in `shared/projection.ts` with it.
  - `partyLights(objects: SceneObject[], pxPerMeter: number, walls: Segment[]): FogShape[]`
    - Returns one `{kind:'polygon'}` per object that is a party token, is not GM_ONLY or SELECTED_PLAYERS, and has `lightRadiusMeters > 0`.
  - `type ExploredGrid = { cellPx: number; cols: number; rows: number; bits: Uint8Array }`
    - `cellPx = max(4, ceil(max(widthPx, heightPx) / 512))`.
    - Functions:
      - `createExplored(widthPx, heightPx): ExploredGrid`
      - `markPolygon(g, points): boolean`: marks cells whose centre is inside; returns whether anything changed.
      - `exploredContains(g, p): boolean`
      - `encodeExplored(g): string`: run lengths of alternating 0/1 cells starting with 0s, as LEB128 varints, then base64 (with the header `cellPx,cols,rows` as varints first).
      - `decodeExplored(s): ExploredGrid`
  - `FogState` gains `explored?: ExploredGrid; lights?: FogShape[]`.
  - `isFogged(fog, p)` order:
    1. If any light contains p, the point is not fogged.
    2. Otherwise the last GM op containing p decides.
    3. Otherwise, if explored contains p, the point is not fogged.
    4. Otherwise use `initial`.

- [ ] **Step 1: Write the failing tests**
  - `lightPolygon blocked by wall`: origin (50,50), radius 100, a wall from (80,0) to (80,100). Every polygon point has x ≤ 80.01, and some point has x < 0 (the light reaches left unobstructed).
  - `lightPolygon without walls`: every point is at distance ≤ 100.01 from the origin, and there are at least 96 points.
  - `partyLights ignores hidden and non-party`: given a PC (visible, 3 m), a PC that is GM_ONLY, and a CREATURE with a radius, the result has length 1.
  - `explored round-trip`: a 4096 × 4096 grid has cellPx 8; mark a 1000 × 1000 square; `decodeExplored(encodeExplored(g))` has identical bits, and `encodeExplored(g).length < 8000`.
  - `isFogged precedence`:
    - With fog covered, explored marking the point, and a later GM conceal op over the point: fogged.
    - The same plus a light covering the point: not fogged.
    - Covered, explored only: not fogged.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run shared/lighting shared/domain.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `light.ts`, `explored.ts` and the `fog.ts` changes. Existing `isFogged` callers keep working because the new fields are optional.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `npx vitest run shared`. Expected: all PASS, including the existing fog tests.
- [ ] **Step 5: Commit** `feat(lighting): light polygons, explored grid, fog precedence`

### Task 3: Data model, inputs, map walls storage, generated-map walls

**Files:**
- Modify: `shared/model.ts`, `shared/schemas/api.ts`, `shared/schemas/commands.ts`, `shared/schemas/common.ts`, `server/services/maps.ts`, `server/services/floorplans.ts`
- Test: `test/integration/lighting.test.ts` (new; map-level cases only in this task)

**Interfaces:**
- **Produces:**
  - `MapDefinition.walls?: MapWalls`
  - `Scene.lighting?: { torch: 'off' | 'remember' | 'live'; roomReveal: boolean }` (absent means off/false)
  - `SceneObject.lightRadiusMeters?: number`
  - `UpdateMapInput.walls: MapWallsSchema.nullable().optional()` (≤ 200 rooms, ≤ 400 doorways; points within map bounds, validated server-side)
  - The `updateSceneObject` patch gains `lightRadiusMeters: z.number().min(0).max(100).nullable()`.
  - New command `setSceneLighting: z.object({ sceneId: Id, torch: z.enum(['off','remember','live']), roomReveal: z.boolean() })`
  - `loadMapWalls(deps, map): Promise<MapWalls | null>`, exported from `server/services/maps.ts`:
    - Returns `map.walls` if set.
    - Otherwise, if a campaign `FLOORPLAN#` record lists this `mapId`, it regenerates the floorplan, computes `floorplanToWalls` with `map.calibration.pixelsPerMeter`, saves it to the map once, and returns it.
    - Otherwise returns null.
  - `createFloorplan` sets `walls` on each new map directly.
  - `GET /campaigns/:cid/maps/:mid` returns `walls` (via `loadMapWalls`) so the editor and table can show it.

- [ ] **Step 1: Write the failing integration tests** in `test/integration/lighting.test.ts`. Use the harness and map upload pattern from `test/integration/polish.test.ts`.
  - `stores walls on an uploaded map`: PATCH `walls` with one room is reflected by GET. A room point outside the map gives 400. A player PATCH gives 403.
  - `generated maps get walls`: create a floorplan via `/campaigns/:cid/floorplans` (copy the setup from `test/integration/floorplans.test.ts`). Each map's GET includes walls whose room count equals that floor's rooms.
  - `old generated maps are backfilled`: remove `walls` from a generated map directly in the db. GET returns walls again, and the db now has them.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run test/integration/lighting.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the types, schemas, `loadMapWalls`, the map PATCH and GET changes, and the floorplan wiring. `updateSceneObject`'s handling of `lightRadiusMeters` comes in Task 4, so just accept it in the schema now.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `npx vitest run test/integration/lighting.test.ts test/integration/floorplans.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lighting): walls on maps, lighting fields and inputs`

### Task 4: Server lighting engine and realtime

**Files:**
- Create: `server/services/lighting.ts`
- Modify: `server/services/sessions.ts` (`loadFog`), `server/realtime/fanout.ts`, `shared/events.ts`, `server/services/commands.ts` (moveToken, spawnSceneObject, updateSceneObject, removeSceneObject, transferSceneObject, resetFog, the new setSceneLighting, executeCommand retry), `server/services/undo.ts`, `server/services/checkpoints.ts`, `server/repo/db.ts` (`keys.explored(sceneId) = { PK: SCENE#id, SK: 'EXPLORED' }`)
- Test: `test/integration/lighting.test.ts`

**Interfaces:**
- **Consumes:** everything from Tasks 1–3.
- **Produces:**
  - Explored record: `{ encoded: string; version: number }` at `keys.explored`. Map deletion already wipes the scene partition.
  - `loadFog(deps, scene, opts?: { objects?: SceneObject[] })` now returns `FogState` with `explored` (decoded) and `lights`. Lights are computed only when `scene.lighting?.torch` is not off and the map is calibrated. When objects aren't passed, it loads them.
  - `lightingUpdate(ctx, scene, objectsAfter: SceneObject[], moved?: { from: Point; to: Point; id: string }): Promise<{ change: Change | null; write: TxItem | null; fogAfter: FogState }>`
    - Computes the new lights.
    - In `remember` mode it marks the explored area: a light polygon at each sample along the straight line from `moved.from` to `moved.to`, every `radiusPx/2`, at most 40 samples.
    - With `roomReveal` on, it marks the rooms containing each visible party token, using `markPolygon` on the room polygon.
    - It returns:
      - a `{ kind: 'fogLayers'; sceneId; objects; fogBefore; fogAfter }` change when lights or explored changed,
      - a conditional Put of the explored record (`version = :v`, or `attribute_not_exists`) when explored changed.
  - Fan-out `fogLayers`:
    - Emits `{ type: 'FOG_LAYERS'; sceneId; explored: string | null; lights: FogShape[] }` to every audience of a visible scene.
    - For players it also emits UPSERTED or REMOVED for objects whose `canViewerSeeObject` flips between `fogBefore` and `fogAfter`. Reuse the 'fog' case's loop.
  - Snapshot: `scene.fog` carries `explored` as its encoded string; the DTO type becomes `{ initial; ops; explored: string | null; lights: FogShape[] }`.
  - Commands that call `lightingUpdate` when the scene's lighting is on, or explored exists for room reveal:
    - moveToken (with `moved`)
    - spawnSceneObject and transferSceneObject (target scene) for party tokens
    - updateSceneObject when `lightRadiusMeters`, `visibility`, `objectType` or `assignedControllerSub` changes
    - removeSceneObject for a lit token
    - undoLast and restoreCheckpoint (recompute lights; explored unchanged)
    - setSceneLighting: writes `scene.lighting`; switching on marks the current lights (remember) and the current rooms (roomReveal) at once.
  - updateSceneObject rejects `lightRadiusMeters > 0`:
    - on a non-party token: 400, "Only party tokens can carry light."
    - on an uncalibrated map: 400, "Set the map's scale before giving tokens light."
  - resetFog also deletes the explored record and emits `fogLayers`.
  - Checkpoints save and restore the explored encoded string.
  - executeCommand: a conditional failure whose cause is the explored record re-runs handler and commit once. Detect it by catching `isConditionalFailure` and re-reading the explored version.

- [ ] **Step 1: Write the failing integration tests** in `test/integration/lighting.test.ts`.
  - Setup:
    - a 600 × 400 map calibrated at 10 px/m, with walls: room A (0,0)–(300,400), room B (300,0)–(600,400), and a doorway at x=300 from y=180 to y=220,
    - a scene with `fogInitial: 'covered'`, live session,
    - a PC token for Alice at (150,200),
    - a VISIBLE_TO_ALL creature "Ghoul" at (450,100) in room B.
  - `GM-only lighting controls`: Alice calling `setSceneLighting` gets 403.
  - `light radius only on party tokens`: setting it on Ghoul gives 400 "Only party tokens can carry light."; on an uncalibrated scene's PC it gives 400 "Set the map's scale".
  - `live torch hides what is out of light`:
    - Set lighting live and Alice's PC radius 10 m (100 px). Alice's snapshot has no Ghoul, and `fog.lights.length === 1`.
    - GM moves the PC to (420,110): Alice's published events include UPSERTED Ghoul and FOG_LAYERS.
    - Move it back: REMOVED Ghoul.
  - `light stops at walls`: PC at (250,100), radius 30 m. Ghoul is not visible to Alice, because the wall blocks it and the doorway is too far down.
  - `remember keeps explored`: in remember mode, after moving into room B and back, Ghoul stays visible to Alice. Alice's snapshot `fog.explored` is non-null.
  - `room reveal on entry`: with torch off and roomReveal on, moving the PC to (310,300) reveals all of room B, so Ghoul at (450,100) becomes visible. Placing a creature in room A changes nothing.
  - `hidden PC lights nothing`: set the PC to GM_ONLY in live mode; Alice's `fog.lights` is empty.
  - `GM fog undo still works`: after automatic reveals, the GM paints a reveal and `undoLast` succeeds.
  - `reset clears explored`: `resetFog` makes Alice's `fog.explored` null and Ghoul invisible.
  - `concurrent moves both succeed`: in remember mode, two lit PCs (Alice's and Bob's) are moved in parallel with `Promise.all`; both return 200.
  - `on-shared-wall position reveals both rooms`: in room reveal mode, a PC moved to (300,50) reveals both A and B.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run test/integration/lighting.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `lighting.ts`, the `loadFog` change, the fan-out case, the `FOG_LAYERS` event type and the command wiring listed above.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `npm test`. Expected: all PASS. The existing fog, undo, checkpoint and security tests are unchanged.
- [ ] **Step 5: Commit** `feat(lighting): server lighting, room reveal and realtime layers`

### Task 5: Client sync and fog rendering

**Files:**
- Modify: `src/features/tabletop/store.ts`, `src/features/tabletop/sync.ts`, `src/features/tabletop/renderer/TabletopRenderer.ts`, `shared/dto.ts`

**Interfaces:**
- **Consumes:** the `FOG_LAYERS` event and snapshot fog shape (Task 4), and `decodeExplored` (Task 2).
- **Produces:**
  - The store's `fog: FogState` now includes the decoded `explored` and `lights`.
  - `applySnapshot` and the `FOG_LAYERS` handler set both and bump `fogVersion`. FOG_UPDATED and FOG_RESET keep the layers.
  - Renderer `setFog` draws in the order: initial, explored (destination-out, `fillRect` per run of set cells), GM ops, lights (destination-out polygons).
  - GMs see lit areas outlined faintly (overlay stroke) on top of their tinted fog.

- [ ] **Step 1: Add a DEV-only test hook.** In `store.ts`, next to the existing `__d20` hook, add `__d20.isFoggedAt(p)`, which returns `isFogged(getTable().fog, p)`. Task 7's journey uses it.
- [ ] **Step 2: Implement** the store, sync and renderer changes.
- [ ] **Step 3: Verify.** Run `npm run typecheck && npm run lint`. Expected: clean. The behaviour is covered by Task 7's journey.
- [ ] **Step 4: Commit** `feat(lighting): client fog layers and rendering`

### Task 6: GM controls on the table

**Files:**
- Modify: `src/features/tabletop/panels/GMPanel.tsx`

**Interfaces:**
- **Consumes:** `setSceneLighting`, and the `lightRadiusMeters` patch (Tasks 3–4).
- **Produces:**
  - A **"Fog automation"** section at the top of the GM panel, for the shown scene:
    - **Torchlight**, a segmented control: Off | Remember explored | Live only.
    - **Reveal rooms when a character walks in**, a checkbox.
    - The hint "No walls on this map yet: add them in Scale & grid." when the map has no walls, with a link to `/campaigns/:cid/maps/:mid`.
  - Token inspector (party tokens only): **Light radius**, a Select with None, 5, 10, 15, 20, 30, 60 ft (or 1.5, 3, 4.5, 6, 9, 18 m when `grid.displayUnit` is metric) plus Custom… (a numeric input). It stores meters and is disabled with the hint "Set the map's scale first" when uncalibrated.

- [ ] **Step 1: Implement** the section and the inspector field.
- [ ] **Step 2: Verify in the browser.** On the local demo table as the GM: set Aria's light to 15 ft and Torchlight to Live. Check Player display, which should show a lit circle around Aria and darkness elsewhere, then set Torchlight back to Off.
- [ ] **Step 3: Commit** `feat(lighting): GM lighting controls and token light radius`

### Task 7: Walls and rooms editor, journey, docs

**Files:**
- Create: `src/features/maps/WallsEditor.tsx`, `e2e/lighting.spec.ts`
- Modify: `src/features/maps/MapSetupPage.tsx`, `docs/API.md`, `docs/ARCHITECTURE.md` (fog section), `IMPLEMENTATION_STATUS.md`

**Interfaces:**
- **Consumes:** map `walls` via GET and PATCH (Task 3).
- **Produces:** a **"Walls & rooms"** section on MapSetupPage, below the grid section, with:
  - Tools: **Rectangle room** (drag), **Shape room** (click points, click the first point or double-click to close), **Doorway** (click two points on a room edge, snapped to the nearest edge within 12 screen px), and **Delete** (click a room or doorway).
  - A room list with rename and delete.
  - Rooms are drawn as translucent fills with outlines on the existing SVG overlay, and doorways as dashed gaps.
  - **Save walls** PATCHes `walls`.
  - **Generated maps:** the walls are shown read-only with the note "Walls come from the generator."

- [ ] **Step 1: Write the journey** `e2e/lighting.spec.ts`.
  - The GM uploads a 600 × 400 map via the API, calibrates it via the API (10 px/m) and opens Scale & grid.
  - The GM draws two rectangle rooms with the UI tool and saves. The API GET shows 2 rooms.
  - On the live table, the GM turns on room reveal (UI checkbox) and moves the player's PC (API) into room 2.
  - The player's `__d20.isFoggedAt(room 2 centre)` polls to false, and `isFoggedAt(room 1 centre)` stays true (`fogInitial: 'covered'`).
- [ ] **Step 2: Run it and confirm it fails.** Run `npx playwright test e2e/lighting.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `WallsEditor` and hook it into MapSetupPage.
- [ ] **Step 4: Run the journey and the full suite.** Run `npx playwright test && npm test && npm run typecheck && npm run lint`. Expected: all PASS.
- [ ] **Step 5: Update the docs.**
  - API.md: map `walls`, `setSceneLighting`, the `FOG_LAYERS` event.
  - ARCHITECTURE.md: fog layers and precedence.
  - IMPLEMENTATION_STATUS.md: a new line under features.
- [ ] **Step 6: Commit** `feat(lighting): walls and rooms editor, journey and docs`

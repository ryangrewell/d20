# Torchlight and room reveal: design

Status: agreed in conversation on 2026-10-29. A builder check has been done, and its questions are answered below.

## Why

GMs spend a lot of the session painting fog by hand. Two moments come up constantly at the user's table:

- A character carries a light, such as a torch (10–15 ft in their games). The area around them should clear as they walk, without the GM painting it.
- A player character steps into a room, and the whole room should be revealed at once.

Both should take work off the GM. The GM can switch either one on or off during a session.

## Goals

1. **Torchlight.** The GM gives specific **party tokens** a light radius in feet or metres, from the map's scale. Fog clears around those tokens as they move.
   - It is purely a GM-set mechanic. Nothing on character sheets or in inventories is involved: no torch items, no player settings.
   - The GM chooses per scene between:
     - **Remember explored areas:** cleared areas stay revealed.
     - **Don't remember:** only what is currently lit is visible. Anything else is visible only if the GM revealed it by hand.
2. **Room reveal.** When a player character's token ends a move inside a room, the whole room is revealed and stays revealed.
3. **Walls.**
   - **Generated maps:** use the rooms, walls and door openings the interior generator already produces. No setup is needed.
   - **Uploaded maps:** the GM marks walls on the existing Scale & grid screen, under a new "Walls & rooms" section.
4. **Light stops at walls.** On a map with walls, torchlight doesn't shine through them into the next room.
5. **Switchable mid-session.** Both features are toggled from the live table's GM tools, per scene, and take effect immediately.

## Non-goals (for this version)

- Per-player vision. Fog stays shared by the whole party, as it is today.
- Darkvision, dim versus bright light, coloured light, and flicker effects.
- Doors that open and close. On generated maps doorways are always open gaps.
- Automatically detecting walls from an uploaded image.
- Light carried by characters (sheets) or items rather than tokens. Light is a GM-set property of the token.
- **Light from monsters, NPCs, loot or props.** Only party tokens (type PC, or controlled by a player) can carry light. To show a lit room with a monster in it, the GM paints that room with the reveal brush as today. *(User's decision.)*

## Anti-goals (would make it a failure even if it "works")

- **Leaking secrets.** A hidden monster standing in the dark must not reach players' browsers. That includes light that only the GM's screen calculates, and the "don't remember" mode. The server decides what's lit, exactly as it already decides what's fogged.
- **Running out of fog space.** In "remember" mode, every step must not add fog data until the scene hits the existing 5,000-operation limit within a session.
- **Slowing down token moves.** A move with lighting on should still feel instant.
- **Breaking existing fog.** The GM's own reveal and conceal painting must keep working and keep its meaning.

## Decisions made with the user

- **Both features:** torchlight radius per token, plus whole-room reveal on entry.
- **Wall sources:** generated maps use their own walls; uploaded maps get a GM walls tool on the Scale & grid screen.
- **Torchlight memory:** a GM choice between "remember fog reveal" and "don't remember".
- **Who can carry light:** party tokens only. Monsters never light anything for players.
- **No inventory or player involvement:** the GM alone sets who has light and how far it reaches.
- **When it applies:** both features are options the GM can change while running a session.

## Proposed behaviour (Claude's calls; the user may adjust)

- **Where things are configured:**
  - Walls and rooms belong to the map, because they are geometry.
  - The torchlight on/off switch, the remember/don't-remember choice, and room reveal on/off belong to the scene, because fog lives on the scene.
  - A party token's light radius belongs to the token. It's set by the GM in the token inspector with presets (none, 5, 10, 15, 20, 30, 60 ft) or a custom value. It needs a calibrated map scale, and the field doesn't appear for non-party tokens.
  - **Which lights count:** a light counts for players only if its token is a party token the players can see (not GM_ONLY). A hidden PC's light lights nothing.
- **Walls tool for uploaded maps:**
  - The GM draws **room outlines**, as rectangles or click-to-click polygons, and names them optionally.
  - Each outline is both a room (for room reveal) and a set of walls (for blocking light).
  - The GM can mark **doorway gaps** on an outline edge so light passes through.
  - Areas outside any room have no walls: light there is a plain circle.
  - Rooms can be edited and deleted.
- **Who triggers room reveal:** only tokens of type PC, or tokens controlled by a player. NPCs, creatures and loot never trigger it.
- **Room reveal stays revealed** in both torchlight modes.
- **Automatic reveals are a separate layer.** Explored areas and revealed rooms are stored on the scene in an "explored" layer, kept apart from the GM's hand-painted fog operations.
  - **Order of evaluation:** start from the initial state, then the explored layer reveals, then the GM's own fog operations, where last wins. A GM conceal therefore hides an explored area until the GM reveals it again.
  - **Light on top:** current light from visible party tokens shows through everything, in both modes.
  - **Undo still works:** the GM's fog Undo only looks at GM fog operations, so automatic reveals during play don't make it fail.
  - **Reset fog** clears the explored layer too.
  - **Undoing a move** doesn't remove what that move explored, because players already saw it.
  - **Space:** the explored layer must stay compact, for example by merging, so a long session fits comfortably in storage and in the snapshot.
- **Exploring along a move:** in "remember" mode, a move records light along the path it took, not just where it ended. Light is clipped by walls at each point along the way. The client may send the drag path, or the server may sample the straight line from start to end; that's left to the builder.
- **When room reveal fires:** whenever a visible party token ends up inside a room. That includes:
  - being moved,
  - being placed,
  - arriving through a doorway link or a move to another scene,
  - standing in a room when the GM switches room reveal on, which reveals those rooms immediately.
- **Switching torchlight on in "remember" mode** immediately records what is lit at that moment.
- **The GM's view:** the GM keeps seeing everything, as today. Lit areas and room outlines are drawn as a faint overlay so the GM can see what players see. The existing player display ("Player display") shows exactly the player view.
- **Turning torchlight off in "don't remember" mode:** players lose whatever only the light was showing. Areas already remembered stay revealed.

## Constraints

- **Server-side enforcement.** Visibility decisions are made on the server and used by both the snapshot and the realtime fan-out. That rule today is `canViewerSeeObject` with `isFogged`. Light and room state must feed the same decision, so the GM-only rules and tests continue to hold.
- **Realtime updates.** A token carrying light that moves can make other tokens appear or disappear for players. Those players must get add and remove updates in the same way a fog change triggers them today.
- **Shared code.** Fog evaluation lives in `shared/` and runs both in the browser renderer and on the server. Light geometry should do the same, so both sides agree.
- **Map scale.** Light radius and room data use map pixels via the map's calibration. Light can't be set on an uncalibrated map, and the UI says so.
- **Existing generated maps.** Maps generated before this feature have a stored floorplan record, and the server can regenerate the geometry exactly from it. They must get walls without being regenerated by the GM.
- **Repo conventions.** Strict TypeScript, Zod schemas for every new input, integration tests against DynamoDB Local, Playwright journeys for the user-facing flows, docs updated, and no new runtime dependencies unless clearly justified.

## Left to the builder

- **Light shapes:** how they're computed (for example a visibility polygon against wall segments), and how "remember" mode records explored areas compactly, by merging or coalescing so a session stays well under the fog limit.
- **Storage:** how wall and room data is stored on the map, and how existing generated maps get theirs (on read or by a one-time fill).
- **Server visibility:** how lit-area checks plug into server visibility efficiently, for example caching per scene or only recomputing when a light-bearing token or a wall changes.
- **Visual styling:** lit edges, GM overlays, and the room-drawing UI.
- **Implementation order:** the order of work and how to split commits.

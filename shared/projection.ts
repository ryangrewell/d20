/**
 * Audience projections. The server builds every snapshot and event payload
 * through these functions so players never receive GM-only data.
 */
import { isFogged, type FogState } from './fog';
import type { GameSession, InitiativeState, Scene, SceneObject } from './model';

export type Viewer = { kind: 'gm' } | { kind: 'player'; sub: string };

/** Player-safe object: GM-only fields omitted entirely (not nulled). */
export type PublicSceneObject = Omit<SceneObject, 'gmNotes' | 'allowedViewerIds' | 'gmStats' | 'portal'>;
export type PublicScene = Omit<Scene, 'gmNotes'>;
export type PublicSession = Omit<GameSession, 'gmNotes'>;

export function canViewerSeeObject(obj: SceneObject, viewer: Viewer, fog: FogState): boolean {
  if (viewer.kind === 'gm') return true;
  const isOwnToken = obj.assignedControllerSub === viewer.sub;
  if (isOwnToken) return true;
  if (obj.visibility === 'GM_ONLY') return false;
  if (obj.visibility === 'SELECTED_PLAYERS' && !obj.allowedViewerIds?.includes(viewer.sub)) return false;
  // Party tokens stay visible under fog; everything else hidden by fog is not sent.
  const partyToken = obj.objectType === 'PC' || !!obj.assignedControllerSub;
  if (!partyToken && isFogged(fog, { x: obj.x, y: obj.y })) return false;
  return true;
}

export function publicObject(obj: SceneObject): PublicSceneObject {
  const { gmNotes: _g, allowedViewerIds: _a, gmStats: _s, portal: _p, ...rest } = obj;
  return rest;
}

export function projectObject(obj: SceneObject, viewer: Viewer): SceneObject | PublicSceneObject {
  return viewer.kind === 'gm' ? obj : publicObject(obj);
}

export function publicScene(scene: Scene): PublicScene {
  const { gmNotes: _g, ...rest } = scene;
  return rest;
}

/** Players see only non-hidden combatants; a hidden current turn shows as nobody's. */
export function publicInitiative(state: InitiativeState): InitiativeState {
  const entries = state.entries.filter((e) => !e.hidden);
  const { currentId, ...rest } = state;
  return { ...rest, entries, ...(currentId && entries.some((e) => e.id === currentId) ? { currentId } : {}) };
}

export function publicSession(session: GameSession): PublicSession {
  const { gmNotes: _g, initiative, ...rest } = session;
  return { ...rest, ...(initiative ? { initiative: publicInitiative(initiative) } : {}) };
}

/** Shared-audience view: what any ordinary player (with no private grants) sees. */
export const SHARED_VIEWER: Viewer = { kind: 'player', sub: '__shared__' };

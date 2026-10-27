/**
 * Audience projections. The server builds every snapshot and event payload
 * through these functions so players never receive GM-only data.
 */
import { isFogged, type FogState } from './fog';
import type { GameSession, Scene, SceneObject } from './model';

export type Viewer = { kind: 'gm' } | { kind: 'player'; sub: string };

/** Player-safe object: GM-only fields omitted entirely (not nulled). */
export type PublicSceneObject = Omit<SceneObject, 'gmNotes' | 'allowedViewerIds'>;
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
  const { gmNotes: _g, allowedViewerIds: _a, ...rest } = obj;
  return rest;
}

export function projectObject(obj: SceneObject, viewer: Viewer): SceneObject | PublicSceneObject {
  return viewer.kind === 'gm' ? obj : publicObject(obj);
}

export function publicScene(scene: Scene): PublicScene {
  const { gmNotes: _g, ...rest } = scene;
  return rest;
}

export function publicSession(session: GameSession): PublicSession {
  const { gmNotes: _g, ...rest } = session;
  return rest;
}

/** Shared-audience view: what any ordinary player (with no private grants) sees. */
export const SHARED_VIEWER: Viewer = { kind: 'player', sub: '__shared__' };

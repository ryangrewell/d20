import type { GameSystemAdapter } from './core';
import { genericD20 } from './generic-d20';

const adapters: Record<string, GameSystemAdapter> = { [genericD20.id]: genericD20 };

export function getAdapter(systemId: string): GameSystemAdapter {
  return adapters[systemId] ?? genericD20;
}

export const AVAILABLE_SYSTEMS = Object.values(adapters).map((a) => ({ id: a.id, version: a.version, displayName: a.displayName }));

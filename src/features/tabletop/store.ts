import { create } from 'zustand';
import type { SessionSnapshotDto } from '@shared/dto';
import type { FogOp, FogState } from '@shared/fog';
import type { ChatMessage, SceneObject } from '@shared/model';
import type { PublicSceneObject } from '@shared/projection';
import type { ConnectionStatus } from '@/lib/realtime/transport';

export type TableObject = SceneObject | PublicSceneObject;

export type Tool = 'select' | 'pan' | 'measure' | 'ping' | 'fog-reveal' | 'fog-conceal' | 'spawn';
export type FogBrush = 'rect' | 'brush';

export type RemoteCursor = { sub: string; name: string; color: string; nx: number; ny: number; sceneId: string; at: number };
export type Ping = { id: number; x: number; y: number; color: string; at: number };

export type SpawnTemplate = { objectType: SceneObject['objectType']; label: string; tint: string; visibility: SceneObject['visibility']; assignedControllerSub?: string };

export type TableState = {
  snapshot: SessionSnapshotDto | null;
  objects: Record<string, TableObject>;
  fog: FogState;
  /** Monotonic counter bumped on fog changes so the renderer knows to redraw. */
  fogVersion: number;
  lastFogOp: FogOp | null;
  chat: ChatMessage[];
  revision: number;
  status: ConnectionStatus | 'loading' | 'error' | 'denied';
  error: string | null;
  tool: Tool;
  fogBrush: FogBrush;
  fogBrushRadius: number;
  selectedId: string | null;
  spawn: SpawnTemplate;
  cursors: Record<string, RemoteCursor>;
  pings: Ping[];
  showCursors: boolean;
  hideMyCursor: boolean;
  followGM: boolean;
  focus: { x: number; y: number; zoom: number; at: number } | null;
  unread: number;
};

export const initialTableState = (): TableState => ({
  snapshot: null,
  objects: {},
  fog: { initial: 'revealed', ops: [] },
  fogVersion: 0,
  lastFogOp: null,
  chat: [],
  revision: 0,
  status: 'loading',
  error: null,
  tool: 'select',
  fogBrush: 'rect',
  fogBrushRadius: 40,
  selectedId: null,
  spawn: { objectType: 'CREATURE', label: 'Goblin', tint: '#b23a48', visibility: 'GM_ONLY' },
  cursors: {},
  pings: [],
  showCursors: true,
  hideMyCursor: false,
  followGM: true,
  focus: null,
  unread: 0,
});

export const useTable = create<TableState>(() => initialTableState());
export const setTable = useTable.setState;
export const getTable = useTable.getState;

// Development-only hook so end-to-end tests can read canvas state.
if (import.meta.env.DEV) (window as unknown as { __d20?: unknown }).__d20 = { getTable, setTable };

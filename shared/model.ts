/** Persisted domain entities. GM-only fields are marked; projections strip them for players. */
import type { MapWalls } from './lighting/walls';
import type { MapGrid } from './geometry/grid';
import type { ScaleCalibration, Point } from './geometry/transform';
import type { FogOp } from './fog';

export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'BLOCKED';

export type UserProfile = {
  sub: string;
  displayName: string;
  avatarKey?: string;
  status: AccountStatus;
  suspendedUntil?: string;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
};

export type CampaignRole = 'OWNER' | 'PLAYER' | 'SPECTATOR';

export type CampaignSettings = {
  meetingUrl?: string;
  /** Allow players to whisper each other (GM can always whisper). */
  playerWhispers: boolean;
  /** Players may roll privately to the GM. */
  allowSecretRolls: boolean;
  /** Players may pan/zoom freely instead of following the GM camera. */
  freeCamera: boolean;
  /** The GM's "ordinary foe" in their system; Quick Encounter scales from it. */
  enemyBaseline?: EnemyBaseline;
};

export type EnemyBaseline = { hp: number; ac?: number; initiativeMod: number };

export type Campaign = {
  id: string;
  ownerSub: string;
  title: string;
  description: string;
  systemId: string;
  systemVersion: string;
  status: 'ACTIVE' | 'ARCHIVED';
  settings: CampaignSettings;
  activeSessionId?: string;
  timezone?: string;
  createdAt: string;
  updatedAt: string;
};

export type CampaignMember = {
  campaignId: string;
  userSub: string;
  role: CampaignRole;
  status: 'ACTIVE' | 'REMOVED';
  displayName: string;
  color: string;
  joinedAt: string;
  /** Set on removal. A GM's invite link created after this lets the player rejoin; older links don't. */
  removedAt?: string;
  /** Platform-admin removals can't be undone by the GM with a new link. */
  removedByAdmin?: boolean;
};

export type CampaignInvite = {
  id: string;
  campaignId: string;
  tokenHash: string;
  createdBy: string;
  role: 'PLAYER' | 'SPECTATOR';
  expiresAt?: string;
  maxUses?: number;
  useCount: number;
  revokedAt?: string;
  createdAt: string;
};

export type GMDelegation = {
  id: string;
  campaignId: string;
  delegateSub: string;
  grantedBy: string;
  scope:
    | { kind: 'SESSIONS'; sessionIds: string[] }
    | { kind: 'NEXT_N_SESSIONS'; fromSessionNumber: number; count: number }
    | { kind: 'TIME_WINDOW'; startsAt: string; endsAt: string };
  permissions: { scenes: boolean; members: boolean; characters: boolean };
  revokedAt?: string;
  createdAt: string;
};

export type SessionStatus = 'PLANNED' | 'LIVE' | 'PAUSED' | 'ENDED';

export type GameSession = {
  id: string;
  campaignId: string;
  number: number;
  title: string;
  status: SessionStatus;
  activeSceneId?: string;
  meetingUrl?: string;
  scheduledAt?: string;
  startedAt?: string;
  endedAt?: string;
  /** Monotonic revision of durable session state. */
  revision: number;
  /** Rotated when access is revoked so stale subscriptions stop receiving events. */
  accessEpoch: number;
  /** GM-only. */
  gmNotes?: string;
  /** Combat tracker; hidden entries are stripped for players. */
  initiative?: InitiativeState;
  createdAt: string;
  updatedAt: string;
};

export type MapCategory = 'world' | 'region' | 'city' | 'outdoor' | 'building' | 'floor' | 'dungeon' | 'encounter' | 'other';

export type MapAsset = {
  id: string;
  campaignId: string;
  s3Key: string;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
  widthPx: number;
  heightPx: number;
  status: 'PENDING' | 'READY';
  uploadedBy: string;
  createdAt: string;
};

export type MapDefinition = {
  id: string;
  campaignId: string;
  assetId: string;
  name: string;
  category: MapCategory;
  parentMapId?: string;
  widthPx: number;
  heightPx: number;
  calibration?: ScaleCalibration;
  grid: MapGrid;
  createdAt: string;
  updatedAt: string;
  /** Rooms and doorways for automatic fog reveal; generated maps get these from the floorplan. */
  walls?: MapWalls;
};

export type SceneLighting = { torch: 'off' | 'remember' | 'live'; roomReveal: boolean };

export type Scene = {
  id: string;
  campaignId: string;
  mapId: string;
  name: string;
  parentSceneId?: string;
  fogInitial: 'covered' | 'revealed';
  fogOpCount: number;
  /** GM-only. */
  gmNotes?: string;
  createdAt: string;
  updatedAt: string;
  /** GM's fog automation for this scene; absent = all off. */
  lighting?: SceneLighting;
};

export type ObjectVisibility = 'GM_ONLY' | 'VISIBLE_TO_ALL' | 'SELECTED_PLAYERS';
export type SceneObjectType = 'PC' | 'NPC' | 'CREATURE' | 'LOOT' | 'PROP' | 'PIN';

export type SceneObject = {
  id: string;
  sceneId: string;
  campaignId: string;
  objectType: SceneObjectType;
  x: number;
  y: number;
  /** Token footprint diameter in meters. Falls back to grid interval if absent. */
  sizeMeters?: number;
  rotationRadians: number;
  zIndex: number;
  visibility: ObjectVisibility;
  allowedViewerIds?: string[];
  assignedControllerSub?: string;
  appearance: { label?: string; imageAssetId?: string; tint?: string };
  /** Visible status effects, e.g. "Prone". */
  conditions?: string[];
  /** Links a PC token to its character sheet. */
  characterId?: string;
  /** Contents of a LOOT object that players may pick up. */
  loot?: LootEntry[];
  /** GM-only: this pin is a doorway/staircase leading to another scene. */
  portal?: { targetSceneId: string };
  /** GM-only. */
  gmNotes?: string;
  /** GM-only creature stats (HP, AC, initiative) copied from a template or set ad hoc. */
  gmStats?: CreatureStats & { templateId?: string };
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** GM-set torchlight radius; party tokens only. */
  lightRadiusMeters?: number;
};

export type LootEntry = { id: string; name: string; description?: string; quantity: number };

export type CreatureStats = { hp?: { current: number; max: number }; ac?: number; initiativeMod?: number };

export type CreatureTemplate = {
  id: string;
  campaignId: string;
  name: string;
  tint: string;
  sizeMeters?: number;
  hpMax: number;
  ac?: number;
  initiativeMod: number;
  /** Free-form stat block / tactics. GM-only. */
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type EncounterTemplate = {
  id: string;
  campaignId: string;
  name: string;
  /** GM-only tactics / trigger notes. */
  notes: string;
  groups: { creatureId: string; count: number }[];
  createdAt: string;
  updatedAt: string;
};

export type JournalVisibility = 'GM_ONLY' | 'ALL' | 'SELECTED_PLAYERS';

export type JournalEntry = {
  id: string;
  campaignId: string;
  title: string;
  /** Plain text; rendered as text, never HTML. */
  body: string;
  visibility: JournalVisibility;
  allowedViewerIds?: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type Character = {
  id: string;
  campaignId: string;
  /** The player who controls this character. */
  ownerSub: string;
  name: string;
  systemId: string;
  systemVersion: string;
  /** Adapter-defined sheet data; unknown keys are preserved across upgrades. */
  sheet: Record<string, unknown>;
  conditions: string[];
  /** GM-only. */
  gmNotes?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ItemState = 'EQUIPPED' | 'CARRIED' | 'STASHED';

export type InventoryItem = {
  id: string;
  characterId: string;
  campaignId: string;
  name: string;
  description: string;
  quantity: number;
  weight?: number;
  tags: string[];
  charges?: { current: number; max: number };
  state: ItemState;
  /** GM-only note on the item; never shown to the player. */
  gmNote?: string;
  createdAt: string;
  updatedAt: string;
};

export type InitiativeEntry = {
  id: string;
  label: string;
  value: number;
  objectId?: string;
  characterId?: string;
  /** Hidden from players (e.g. an unrevealed monster). */
  hidden: boolean;
};

export type InitiativeState = {
  active: boolean;
  round: number;
  /** Id of the entry whose turn it is. */
  currentId?: string;
  entries: InitiativeEntry[];
};

export type FogOpRecord = { sceneId: string; seq: number; op: FogOp; createdAt: string };

export type ChatScope = 'TABLE' | 'WHISPER';

export type ChatMessage = {
  id: string;
  campaignId: string;
  sessionId?: string;
  senderSub: string;
  senderName: string;
  scope: ChatScope;
  /** For whispers: everyone who may read it (always includes sender). */
  recipientSubs?: string[];
  body: string;
  kind: 'TEXT' | 'SYSTEM' | 'ROLL';
  roll?: DiceRollRecord;
  createdAt: string;
};

export type DiceRollVisibility = 'PUBLIC' | 'GM' | 'SELF';

export type DiceRollRecord = {
  expression: string;
  total: number;
  detail: string;
  visibility: DiceRollVisibility;
  label?: string;
};

export type CursorPacket = {
  sceneId: string;
  /** Normalised 0..1 map coordinates. */
  nx: number;
  ny: number;
  seq: number;
  ping?: boolean;
};

export type PresenterFocus = { sceneId: string; center: Point; zoom: number };

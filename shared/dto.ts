/** API response shapes shared by server and client. */
import type { FogOp, FogShape } from './fog';

/** Fog as sent to clients: the explored grid travels encoded (see shared/lighting/explored). */
export type FogWire = { initial: 'covered' | 'revealed'; ops: FogOp[]; explored: string | null; lights: FogShape[] };
import type { Campaign, CampaignInvite, CampaignRole, CampaignSettings, ChatMessage, GameSession, MapDefinition, Scene, SceneObject } from './model';
import type { PublicScene, PublicSceneObject, PublicSession } from './projection';

export type MeDto = { sub: string; displayName: string; isPlatformAdmin: boolean; status: string; createdAt: string };

export type CampaignListItem = { campaign: Campaign; role: CampaignRole };

export type MemberDto = { userSub: string; role: CampaignRole; status: string; displayName: string; color: string; joinedAt: string };

export type CampaignDashboardDto = {
  campaign: Campaign;
  access: { isOwner: boolean; isGM: boolean; role: CampaignRole };
  members: MemberDto[];
  sessions: Omit<GameSession, 'gmNotes'>[];
  maps: MapDefinition[];
  scenes: { id: string; name: string; mapId: string; parentSceneId?: string; updatedAt: string }[];
};

export type InviteDto = Omit<CampaignInvite, 'tokenHash'> & { status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'USED_UP' };

export type InvitePreviewDto = { campaignId: string; title: string; gmName: string; role: string; alreadyMember: boolean; blockedReason: string | null };

export type SnapshotMember = { userSub: string; displayName: string; color: string; role: CampaignRole };

export type SceneSnapshot = {
  scene: Scene | PublicScene;
  map: MapDefinition;
  imageUrl: string | null;
  objects: (SceneObject | PublicSceneObject)[];
  fog: FogWire;
  fogSeq: number;
};

export type SessionSnapshotDto = {
  session: GameSession | PublicSession;
  campaign: { id: string; title: string; systemId: string; settings: CampaignSettings };
  me: { sub: string; displayName: string; isGM: boolean; isOwner: boolean; color: string };
  viewMode: 'gm' | 'player' | 'preview';
  members: SnapshotMember[];
  channels: string[];
  revision: number;
  chat: ChatMessage[];
  waiting: boolean;
  scene: SceneSnapshot | null;
};

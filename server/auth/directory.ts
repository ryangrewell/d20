/**
 * Identity-provider operations the admin area needs. Production uses the
 * Cognito user pool (live group checks, enable/disable sign-in); local
 * development uses the dev auth emulator's records.
 */
import {
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { UserProfile } from '@shared/model';
import { keys, type Db } from '../repo/db';
import { PLATFORM_ADMIN_GROUP } from './verify';

export interface UserDirectory {
  /** Live check, not the (possibly stale) token claim. */
  isAdmin(sub: string): Promise<boolean>;
  listAdmins(): Promise<string[]>;
  removeAdmin(sub: string): Promise<void>;
  setSignInEnabled(sub: string, enabled: boolean): Promise<void>;
}

export class CognitoDirectory implements UserDirectory {
  private client: CognitoIdentityProviderClient;
  private cache = new Map<string, { admin: boolean; at: number }>();
  constructor(private userPoolId: string, region: string) {
    this.client = new CognitoIdentityProviderClient({ region });
  }
  // With email sign-in, the Cognito username is the user's sub.
  async isAdmin(sub: string) {
    const hit = this.cache.get(sub);
    if (hit && Date.now() - hit.at < 30_000) return hit.admin;
    const r = await this.client.send(new AdminListGroupsForUserCommand({ UserPoolId: this.userPoolId, Username: sub }));
    const admin = !!r.Groups?.some((g) => g.GroupName === PLATFORM_ADMIN_GROUP);
    this.cache.set(sub, { admin, at: Date.now() });
    return admin;
  }
  async listAdmins() {
    const r = await this.client.send(new ListUsersInGroupCommand({ UserPoolId: this.userPoolId, GroupName: PLATFORM_ADMIN_GROUP, Limit: 60 }));
    return (r.Users ?? []).map((u) => u.Attributes?.find((a) => a.Name === 'sub')?.Value ?? u.Username!).filter(Boolean);
  }
  async removeAdmin(sub: string) {
    await this.client.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: this.userPoolId, Username: sub, GroupName: PLATFORM_ADMIN_GROUP }));
    this.cache.delete(sub);
  }
  async setSignInEnabled(sub: string, enabled: boolean) {
    await this.client.send(enabled ? new AdminEnableUserCommand({ UserPoolId: this.userPoolId, Username: sub }) : new AdminDisableUserCommand({ UserPoolId: this.userPoolId, Username: sub }));
  }
}

type DevUser = { email: string; sub: string; groups?: string[]; disabled?: boolean };

/** LOCAL DEVELOPMENT ONLY: reads/writes the dev auth emulator's records. */
export class DevDirectory implements UserDirectory {
  constructor(private db: Db) {}
  private async devUser(sub: string): Promise<DevUser | null> {
    const profile = await this.db.get<UserProfile & { email?: string }>(keys.profile(sub));
    return profile?.email ? this.db.get<DevUser>(keys.devAuth(profile.email)) : null;
  }
  async isAdmin(sub: string) {
    return !!(await this.devUser(sub))?.groups?.includes(PLATFORM_ADMIN_GROUP);
  }
  async listAdmins() {
    const users = await this.db.query<UserProfile>({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :u', ExpressionAttributeValues: { ':u': 'USERS' } });
    const out: string[] = [];
    for (const u of users) if (await this.isAdmin(u.sub)) out.push(u.sub);
    return out;
  }
  async removeAdmin(sub: string) {
    const u = await this.devUser(sub);
    if (u) await this.db.update({ Key: keys.devAuth(u.email), UpdateExpression: 'SET #g = :g', ExpressionAttributeNames: { '#g': 'groups' }, ExpressionAttributeValues: { ':g': (u.groups ?? []).filter((g) => g !== PLATFORM_ADMIN_GROUP) } });
  }
  async setSignInEnabled(sub: string, enabled: boolean) {
    const u = await this.devUser(sub);
    if (u) await this.db.update({ Key: keys.devAuth(u.email), UpdateExpression: 'SET disabled = :d', ExpressionAttributeValues: { ':d': !enabled } });
  }
}

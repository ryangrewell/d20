import { beforeAll, describe, expect, it } from 'vitest';
import { keys } from '@server/repo/db';
import { authorizeChannel } from '@server/realtime/authorize';
import { channelPath } from '@shared/events';
import { createHarness, infraAvailable, makePng, type Harness, type TestUser } from './harness';

const available = await infraAvailable();
const d = available ? describe : describe.skip;

d('GM delegation, moderation, reports and audit', () => {
  let h: Harness;
  let owner: TestUser, alice: TestUser, bob: TestUser, admin: TestUser;
  let campaignId: string, s1: string, sceneId: string;

  const makeAdmin = (u: TestUser) => h.deps.db.put({ ...keys.devAuth(`${u.name}@test.dev`), email: `${u.name}@test.dev`, sub: u.sub, groups: ['platform-admin'] });
  const epoch = async (sid: string) => (await h.deps.db.get<{ accessEpoch: number }>(keys.session(sid)))!.accessEpoch;
  const auditActions = async () => (await admin.call('GET', '/admin/audit')).body.map((e: { action: string }) => e.action);
  const spawn = (u: TestUser, sid = s1) => u.command(sid, 'spawnSceneObject', { sceneId, objectType: 'CREATURE', x: 10, y: 10, label: 'Probe' });

  beforeAll(async () => {
    h = await createHarness();
    [owner, alice, bob, admin] = await Promise.all([h.user('owner'), h.user('alice'), h.user('bob'), h.user('admin', ['platform-admin'])]);
    // Every user touches the API once so their profile exists.
    await Promise.all([owner, alice, bob, admin].map((u) => u.call('GET', '/me')));
    await makeAdmin(admin);
    campaignId = (await owner.call('POST', '/campaigns', { title: 'Governance' })).body.id;
    const { token } = (await owner.call('POST', `/campaigns/${campaignId}/invites`, {})).body;
    await alice.call('POST', '/invites/accept', { token });
    await bob.call('POST', '/invites/accept', { token });
    const png = await makePng(200, 200);
    const intent = (await owner.call('POST', `/campaigns/${campaignId}/maps/upload-intent`, { fileName: 'm.png', contentType: 'image/png', bytes: png.length })).body;
    await fetch(intent.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Blob([Buffer.from(png)]) });
    const map = (await owner.call('POST', `/campaigns/${campaignId}/maps`, { assetId: intent.assetId, name: 'M' })).body;
    sceneId = (await owner.call('POST', `/campaigns/${campaignId}/scenes`, { mapId: map.id, name: 'S' })).body.id;
    s1 = (await owner.call('POST', `/campaigns/${campaignId}/sessions`, {})).body.id;
    await owner.command(s1, 'switchActiveScene', { sceneId });
    await owner.call('POST', `/sessions/${s1}/transition`, { action: 'start' });
  });

  it('lets only the owner delegate, scoped to a session, and revocation cuts access at once (J6)', async () => {
    const denied = await bob.call('POST', `/campaigns/${campaignId}/delegations`, { delegateSub: bob.sub, scope: { kind: 'SESSIONS', sessionIds: [s1] } });
    expect(denied.status).toBe(403);

    const grant = await owner.call('POST', `/campaigns/${campaignId}/delegations`, { delegateSub: alice.sub, scope: { kind: 'SESSIONS', sessionIds: [s1] } });
    expect(grant.status).toBe(201);
    expect((await spawn(alice)).status).toBe(200);
    expect((await spawn(bob)).status).toBe(403);
    expect((await alice.call('GET', `/sessions/${s1}/snapshot`)).body.viewMode).toBe('gm');
    expect((await alice.call('GET', `/campaigns/${campaignId}`)).body.access.isGM).toBe(true);
    const e = await epoch(s1);
    expect((await authorizeChannel(h.deps, alice.sub, channelPath({ ns: 'game', sessionId: s1, epoch: e, audience: 'gm' }), 'subscribe')).ok).toBe(true);
    // A delegate cannot extend or re-delegate.
    expect((await alice.call('POST', `/campaigns/${campaignId}/delegations`, { delegateSub: bob.sub, scope: { kind: 'SESSIONS', sessionIds: [s1] } })).status).toBe(403);
    expect((await alice.call('GET', `/campaigns/${campaignId}/delegations`)).body).toHaveLength(1);

    await owner.call('POST', `/campaigns/${campaignId}/delegations/${grant.body.id}/revoke`);
    expect((await spawn(alice)).status).toBe(403);
    expect(await epoch(s1)).toBe(e + 1);
    expect((await authorizeChannel(h.deps, alice.sub, channelPath({ ns: 'game', sessionId: s1, epoch: e, audience: 'gm' }), 'subscribe')).ok).toBe(false);
    expect((await authorizeChannel(h.deps, alice.sub, channelPath({ ns: 'game', sessionId: s1, epoch: e + 1, audience: 'gm' }), 'subscribe')).ok).toBe(false);
  });

  it('expires time-window delegations and rekeys before the next broadcast', async () => {
    const now = Date.now();
    await owner.call('POST', `/campaigns/${campaignId}/delegations`, {
      delegateSub: bob.sub,
      scope: { kind: 'TIME_WINDOW', startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 60_000).toISOString() },
    });
    expect((await spawn(bob)).status).toBe(200);
    const before = await epoch(s1);
    const realNow = h.deps.now;
    h.deps.now = () => new Date(now + 5 * 60_000);
    try {
      expect((await spawn(bob)).status).toBe(403);
      h.published.length = 0;
      await owner.command(s1, 'sendChat', { body: 'after expiry' });
      const after = await epoch(s1);
      expect(after).toBeGreaterThan(before);
      // Nothing was broadcast on the old GM channel after expiry.
      const oldGm = channelPath({ ns: 'game', sessionId: s1, epoch: before, audience: 'gm' });
      expect(h.published.filter((p) => p.channel === oldGm && JSON.stringify(p.event).includes('after expiry'))).toHaveLength(0);
    } finally {
      h.deps.now = realNow;
    }
    expect(await auditActions()).toContain('DELEGATION_EXPIRED');
  });

  it('counts "next N sessions" by stable session numbers', async () => {
    await owner.call('POST', `/campaigns/${campaignId}/delegations`, { delegateSub: alice.sub, scope: { kind: 'NEXT_N_SESSIONS', count: 1 } });
    expect((await spawn(alice)).status).toBe(200);
    await owner.call('POST', `/sessions/${s1}/transition`, { action: 'end' });
    const s2 = (await owner.call('POST', `/campaigns/${campaignId}/sessions`, {})).body.id;
    await owner.command(s2, 'switchActiveScene', { sceneId });
    await owner.call('POST', `/sessions/${s2}/transition`, { action: 'start' });
    expect((await spawn(alice, s2)).status).toBe(403);
    s1 = s2;
  });

  it('restricts admin APIs to live platform admins (stale token claims are not enough) (J7)', async () => {
    const fakeAdmin = await h.user('pretender', ['platform-admin']);
    expect((await fakeAdmin.call('GET', '/admin/metrics')).status).toBe(403);
    expect((await bob.call('GET', '/admin/users')).status).toBe(403);
    const m = await admin.call('GET', '/admin/metrics');
    expect(m.status).toBe(200);
    expect(m.body.users.total).toBeGreaterThanOrEqual(4);
    expect(m.body.campaigns.total).toBe(1);
    expect(m.body.campaigns.liveSessions).toBe(1);
    const found = (await admin.call('GET', '/admin/users?q=alice')).body;
    expect(found.map((u: { displayName: string }) => u.displayName)).toEqual(['alice']);
    const camps = (await admin.call('GET', '/admin/campaigns')).body;
    expect(camps[0]).toMatchObject({ title: 'Governance', memberCount: 3, live: true });
    expect(JSON.stringify(camps)).not.toContain('gmNotes');
    expect(await auditActions()).toContain('ADMIN_ACCESS_DENIED');
  });

  it('blocks, suspends and unblocks with audit, cutting off live access (J7)', async () => {
    expect((await admin.call('POST', `/admin/users/${admin.sub}/block`, { reason: 'test self' })).status).toBe(400);
    expect((await admin.call('POST', `/admin/users/${bob.sub}/block`, { reason: '' })).status).toBe(400);
    const e = await epoch(s1);
    expect((await admin.call('POST', `/admin/users/${bob.sub}/block`, { reason: 'Harassment in chat' })).status).toBe(200);
    const r = await bob.call('GET', `/campaigns/${campaignId}`);
    expect(r.status).toBe(403);
    expect(r.body.error.details.accountStatus).toBe('BLOCKED');
    expect(await epoch(s1)).toBeGreaterThan(e);
    expect((await authorizeChannel(h.deps, bob.sub, channelPath({ ns: 'presence', sessionId: s1, epoch: await epoch(s1) }), 'subscribe')).ok).toBe(false);
    const detail = (await admin.call('GET', `/admin/users/${bob.sub}`)).body;
    expect(detail.user.status).toBe('BLOCKED');
    expect(detail.history[0]).toMatchObject({ action: 'USER_BLOCKED', reason: 'Harassment in chat', actorSub: admin.sub });

    await admin.call('POST', `/admin/users/${bob.sub}/unblock`, { reason: 'Appeal accepted' });
    expect((await bob.call('GET', `/campaigns/${campaignId}`)).status).toBe(200);
    expect((await admin.call('POST', `/admin/users/${bob.sub}/suspend`, { reason: 'Cooling off', until: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    await admin.call('POST', `/admin/users/${bob.sub}/suspend`, { reason: 'Cooling off', until: new Date(Date.now() + 86400_000).toISOString() });
    expect((await bob.call('GET', `/campaigns/${campaignId}`)).body.error.details.accountStatus).toBe('SUSPENDED');
    await admin.call('POST', `/admin/users/${bob.sub}/unblock`, { reason: 'Lifted' });
  });

  it('protects the last admin and lets admins remove members with a reason', async () => {
    expect((await admin.call('POST', `/admin/users/${admin.sub}/revoke-admin`, { reason: 'leaving' })).status).toBe(409);
    const second = await h.user('second');
    await second.call('GET', '/me');
    await makeAdmin(second);
    expect((await admin.call('POST', `/admin/users/${second.sub}/revoke-admin`, { reason: 'No longer staff' })).status).toBe(200);
    expect((await second.call('GET', '/admin/metrics')).status).toBe(403);

    expect((await admin.call('POST', `/admin/campaigns/${campaignId}/members/${owner.sub}/remove`, { reason: 'x x x' })).status).toBe(403);
    expect((await admin.call('POST', `/admin/campaigns/${campaignId}/members/${bob.sub}/remove`, { reason: 'Ban evasion' })).status).toBe(200);
    expect((await bob.call('GET', `/campaigns/${campaignId}`)).status).toBe(404);
  });

  it('takes reports only on content the reporter could see, and resolves them with audit', async () => {
    const carol = await h.user('carol');
    await carol.call('POST', '/invites/accept', { token: (await owner.call('POST', `/campaigns/${campaignId}/invites`, {})).body.token });
    const whisper = (await owner.command(s1, 'sendChat', { body: 'secret plan', recipientSubs: [carol.sub] })).body;
    const table = (await owner.command(s1, 'sendChat', { body: 'rude words' })).body;
    expect((await alice.call('POST', '/reports', { targetType: 'MESSAGE', targetId: whisper.result.messageId, campaignId, reason: 'HARASSMENT' })).status).toBe(404);
    const rep = await alice.call('POST', '/reports', { targetType: 'MESSAGE', targetId: table.result.messageId, campaignId, reason: 'HARASSMENT', details: 'Out of line' });
    expect(rep.status).toBe(201);
    const outsider = await h.user('outsider');
    expect((await outsider.call('POST', '/reports', { targetType: 'USER', targetId: owner.sub, campaignId, reason: 'SPAM' })).status).toBe(404);

    const open = (await admin.call('GET', '/admin/reports')).body;
    expect(open[0]).toMatchObject({ reporterName: 'alice', subjectName: 'owner', excerpt: 'rude words', status: 'OPEN', campaignTitle: 'Governance' });
    expect((await alice.call('GET', '/admin/reports')).status).toBe(403);
    expect((await admin.call('POST', `/admin/reports/${rep.body.id}/resolve`, { disposition: 'WARNED', note: 'Spoke to the GM' })).status).toBe(200);
    expect((await admin.call('POST', `/admin/reports/${rep.body.id}/resolve`, { disposition: 'WARNED' })).status).toBe(409);
    expect((await admin.call('GET', '/admin/reports')).body).toHaveLength(0);
    expect(await auditActions()).toEqual(expect.arrayContaining(['REPORT_RESOLVED', 'USER_BLOCKED', 'DELEGATION_GRANTED', 'DELEGATION_REVOKED', 'DELEGATION_DENIED', 'MEMBER_REMOVED_BY_ADMIN', 'ADMIN_REVOKED']));
    // The audit log is append-only: there is no way to change or delete entries.
    expect((await admin.call('DELETE', '/admin/audit')).status).toBe(404);
  });
});

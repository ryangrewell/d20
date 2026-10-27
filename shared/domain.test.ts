import { describe, expect, it } from 'vitest';
import { parseDice, rollDice, DiceError, describeRoll } from './dice/dice';
import { isFogged, type FogState } from './fog';
import { channelPath, parseChannel } from './events';
import { sniffImage } from './image';
import { canViewerSeeObject } from './projection';
import { delegationIsEffective, resolveAccess } from './permissions';
import type { SceneObject, GMDelegation, CampaignMember } from './model';

describe('dice', () => {
  const seq = (values: number[]) => {
    let i = 0;
    return (n: number) => (values[i++ % values.length]! - 1) % n;
  };
  it('parses and rolls standard notation', () => {
    expect(rollDice(parseDice('2d6+3'), seq([4, 5])).total).toBe(12);
    expect(rollDice(parseDice('d20'), seq([17])).total).toBe(17);
    expect(rollDice(parseDice('d%'), seq([42])).total).toBe(42);
    expect(rollDice(parseDice('1d8 - 2'), seq([1])).total).toBe(-1);
  });
  it('keeps highest / drops lowest', () => {
    const r = rollDice(parseDice('4d6kh3'), seq([1, 6, 3, 5]));
    expect(r.total).toBe(14);
    expect(describeRoll(r)).toBe('[~~1~~, 6, 3, 5]');
    expect(rollDice(parseDice('2d20kl1'), seq([15, 4])).total).toBe(4);
    expect(rollDice(parseDice('4d6dl1'), seq([2, 2, 6, 6])).total).toBe(14);
  });
  it('rejects abusive or malformed expressions', () => {
    for (const bad of ['', '1000000d6', '1d1', '1d100000', 'abc', '5', '2d6kh3', '1d6;drop', '101d6', '<script>']) {
      expect(() => parseDice(bad), bad).toThrow(DiceError);
    }
  });
  it('stays within bounds with a real RNG', () => {
    for (let i = 0; i < 500; i++) {
      const t = rollDice(parseDice('3d6'), (n) => Math.floor(Math.random() * n)).total;
      expect(t).toBeGreaterThanOrEqual(3);
      expect(t).toBeLessThanOrEqual(18);
    }
  });
});

describe('fog', () => {
  const fog: FogState = {
    initial: 'covered',
    ops: [
      { mode: 'reveal', shape: { kind: 'rect', x: 0, y: 0, w: 100, h: 100 } },
      { mode: 'conceal', shape: { kind: 'brush', radius: 10, points: [{ x: 50, y: 50 }, { x: 90, y: 50 }] } },
      { mode: 'reveal', shape: { kind: 'polygon', points: [{ x: 200, y: 200 }, { x: 300, y: 200 }, { x: 250, y: 300 }] } },
    ],
  };
  it('applies the last covering operation', () => {
    expect(isFogged(fog, { x: 10, y: 10 })).toBe(false);
    expect(isFogged(fog, { x: 70, y: 55 })).toBe(true);
    expect(isFogged(fog, { x: 250, y: 240 })).toBe(false);
    expect(isFogged(fog, { x: 500, y: 500 })).toBe(true);
    expect(isFogged({ initial: 'revealed', ops: [] }, { x: 1, y: 1 })).toBe(false);
  });
});

describe('channels', () => {
  it('round-trips and rejects anything unexpected', () => {
    const c = { ns: 'game' as const, sessionId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', epoch: 3, audience: 'user' as const, sub: 'abc-123' };
    expect(parseChannel(channelPath(c))).toEqual(c);
    expect(parseChannel('/presence/01HZZZZZZZZZZZZZZZZZZZZZZZ/2')).toEqual({ ns: 'presence', sessionId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', epoch: 2 });
    for (const bad of ['/game/x/1/gm/extra', '/game/x/1/user', '/game/x/a/gm', '/other/x/1', '/game/../1/gm', '/game/x/1/shared/'])
      expect(parseChannel(bad), bad).toBeNull();
  });
});

describe('image sniffing', () => {
  it('reads PNG, JPEG and WebP dimensions', () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x10, 0, 0, 0, 0x08, 0]);
    expect(sniffImage(png)).toEqual({ contentType: 'image/png', width: 4096, height: 2048 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x03, 0x00, 0x05, 0x00, 3, 0, 0, 0, 0, 0, 0]);
    expect(sniffImage(jpeg)).toEqual({ contentType: 'image/jpeg', width: 1280, height: 768 });
    const webp = new Uint8Array(32);
    webp.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    webp.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
    webp.set([0xff, 0x03, 0x00, 0xff, 0x01, 0x00], 24);
    expect(sniffImage(webp)).toEqual({ contentType: 'image/webp', width: 1024, height: 512 });
    expect(sniffImage(new TextEncoder().encode('<svg onload=alert(1)></svg>'))).toBeNull();
  });
});

describe('visibility projection', () => {
  const base: SceneObject = { id: 'o', sceneId: 's', campaignId: 'c', objectType: 'CREATURE', x: 10, y: 10, rotationRadians: 0, zIndex: 0, visibility: 'VISIBLE_TO_ALL', appearance: {}, revision: 1, createdAt: '', updatedAt: '' };
  const clear: FogState = { initial: 'revealed', ops: [] };
  const covered: FogState = { initial: 'covered', ops: [] };
  const p = { kind: 'player' as const, sub: 'p1' };
  it('distinguishes hidden tokens from tokens behind fog', () => {
    expect(canViewerSeeObject({ ...base, visibility: 'GM_ONLY' }, p, clear)).toBe(false);
    expect(canViewerSeeObject(base, p, covered)).toBe(false);
    expect(canViewerSeeObject({ ...base, objectType: 'PC' }, p, covered)).toBe(true);
    expect(canViewerSeeObject({ ...base, visibility: 'SELECTED_PLAYERS', allowedViewerIds: ['p1'] }, p, clear)).toBe(true);
    expect(canViewerSeeObject({ ...base, visibility: 'SELECTED_PLAYERS', allowedViewerIds: ['p2'] }, p, clear)).toBe(false);
    expect(canViewerSeeObject({ ...base, visibility: 'GM_ONLY' }, { kind: 'gm' }, covered)).toBe(true);
  });
});

describe('GM delegation', () => {
  const member: CampaignMember = { campaignId: 'c', userSub: 'b', role: 'PLAYER', status: 'ACTIVE', displayName: 'B', color: '#000000', joinedAt: '' };
  const d = (scope: GMDelegation['scope'], extra: Partial<GMDelegation> = {}): GMDelegation => ({ id: 'd', campaignId: 'c', delegateSub: 'b', grantedBy: 'o', scope, permissions: { scenes: true, members: false, characters: false }, createdAt: '', ...extra });
  it('respects scope, expiry and revocation', () => {
    const s3 = { id: 's3', number: 3 };
    expect(delegationIsEffective(d({ kind: 'SESSIONS', sessionIds: ['s3'] }), s3)).toBe(true);
    expect(delegationIsEffective(d({ kind: 'NEXT_N_SESSIONS', fromSessionNumber: 2, count: 2 }), s3)).toBe(true);
    expect(delegationIsEffective(d({ kind: 'NEXT_N_SESSIONS', fromSessionNumber: 1, count: 2 }), s3)).toBe(false);
    const now = new Date('2026-10-26T12:00:00Z');
    expect(delegationIsEffective(d({ kind: 'TIME_WINDOW', startsAt: '2026-10-26T00:00:00Z', endsAt: '2026-10-27T00:00:00Z' }), null, now)).toBe(true);
    expect(delegationIsEffective(d({ kind: 'TIME_WINDOW', startsAt: '2026-10-25T00:00:00Z', endsAt: '2026-10-26T00:00:00Z' }), null, now)).toBe(false);
    expect(delegationIsEffective(d({ kind: 'SESSIONS', sessionIds: ['s3'] }, { revokedAt: '2026-01-01' }), s3)).toBe(false);
    expect(resolveAccess(member, [d({ kind: 'SESSIONS', sessionIds: ['s3'] })], s3).isGM).toBe(true);
    expect(resolveAccess(member, [], s3).isGM).toBe(false);
    expect(resolveAccess({ ...member, status: 'REMOVED' }, [], s3).canView).toBe(false);
  });
});

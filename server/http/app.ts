/**
 * The HTTP command/query API. Runs unchanged in AWS Lambda (behind API
 * Gateway) and in the local dev server. Every route authenticates the bearer
 * token, resolves the actor from the database, and validates input with the
 * shared Zod schemas.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AppError, HTTP_STATUS } from '@shared/errors';
import {
  AcceptInviteInput,
  CreateCampaignInput,
  CreateInviteInput,
  CreateSceneInput,
  CreateSessionInput,
  FinalizeMapInput,
  SessionTransitionInput,
  UpdateCampaignInput,
  UpdateMapInput,
  UpdateProfileInput,
  UpdateSceneInput,
  UploadMapIntentInput,
} from '@shared/schemas/api';
import { HttpsUrl, plainText } from '@shared/schemas/common';
import { resolveActor, type Actor, type Deps } from '../context';
import type { TokenVerifier } from '../auth/verify';
import * as campaigns from '../services/campaigns';
import * as invites from '../services/invites';
import * as sessions from '../services/sessions';
import * as maps from '../services/maps';
import { executeCommand } from '../services/commands';
import * as characters from '../services/characters';
import * as creatures from '../services/creatures';
import * as encounters from '../services/encounters';
import * as journal from '../services/journal';
import { visibleMessages } from '../services/chat';
import { loadCampaign } from '../context';
import { CreateCharacterInput, CreatureInput, EncounterInput, ImportCharacterInput, ItemInput, JournalInput, UpdateCharacterInput } from '@shared/schemas/characters';

type Env = { Variables: { actor: Actor } };

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = {};
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new AppError('INVALID_INPUT', first?.message ?? 'Invalid input.', { issues: r.error.issues.slice(0, 8).map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}

const IdParam = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
function id(c: Context, name: string): string {
  const v = c.req.param(name);
  if (!IdParam.safeParse(v).success) throw new AppError('NOT_FOUND', 'Not found.');
  return v!;
}

export function createApp(deps: Deps, verify: TokenVerifier, extra?: (app: Hono<Env>) => void) {
  const app = new Hono<Env>().basePath('/api');

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), HTTP_STATUS[err.code] as 400);
    deps.log('error', 'unhandled error', { path: c.req.path, name: (err as Error).name, message: (err as Error).message });
    return c.json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' } }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true, time: deps.now().toISOString() }));

  extra?.(app);

  // Preflight requests never carry credentials; CORS headers are added by API Gateway (or the Vite proxy locally).
  app.options('*', (c) => c.body(null, 204));

  app.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS' || c.req.path === '/api/health' || c.req.path.startsWith('/api/dev/')) return next();
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new AppError('UNAUTHENTICATED', 'Please sign in.');
    const identity = await verify(token);
    c.set('actor', await resolveActor(deps, identity));
    await next();
  });

  // ---------------------------------------------------------------- profile
  app.get('/me', (c) => {
    const a = c.get('actor');
    return c.json({ sub: a.sub, displayName: a.displayName, isPlatformAdmin: a.isPlatformAdmin, status: a.profile.status, createdAt: a.profile.createdAt });
  });
  app.patch('/me', async (c) => c.json(await campaigns.updateMyProfile(deps, c.get('actor'), await body(c, UpdateProfileInput))));

  // -------------------------------------------------------------- campaigns
  app.get('/campaigns', async (c) => c.json(await campaigns.listMyCampaigns(deps, c.get('actor'))));
  app.post('/campaigns', async (c) => c.json(await campaigns.createCampaign(deps, c.get('actor'), await body(c, CreateCampaignInput)), 201));
  app.get('/campaigns/:cid', async (c) => c.json(await campaigns.getCampaignDashboard(deps, c.get('actor'), id(c, 'cid'))));
  app.patch('/campaigns/:cid', async (c) => c.json(await campaigns.updateCampaign(deps, c.get('actor'), id(c, 'cid'), await body(c, UpdateCampaignInput))));
  app.post('/campaigns/:cid/archive', async (c) => c.json(await campaigns.archiveCampaign(deps, c.get('actor'), id(c, 'cid'))));
  app.delete('/campaigns/:cid/members/:sub', async (c) => {
    const sub = c.req.param('sub');
    if (!/^[A-Za-z0-9-]{1,64}$/.test(sub)) throw new AppError('NOT_FOUND', 'Not found.');
    await campaigns.removeMember(deps, c.get('actor'), id(c, 'cid'), sub);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- invites
  app.get('/campaigns/:cid/invites', async (c) => c.json(await invites.listInvites(deps, c.get('actor'), id(c, 'cid'))));
  app.post('/campaigns/:cid/invites', async (c) => c.json(await invites.createInvite(deps, c.get('actor'), id(c, 'cid'), await body(c, CreateInviteInput)), 201));
  app.post('/campaigns/:cid/invites/:iid/revoke', async (c) => {
    await invites.revokeInvite(deps, c.get('actor'), id(c, 'cid'), id(c, 'iid'));
    return c.json({ ok: true });
  });
  app.post('/invites/preview', async (c) => c.json(await invites.previewInvite(deps, c.get('actor'), (await body(c, AcceptInviteInput)).token)));
  app.post('/invites/accept', async (c) => c.json(await invites.acceptInvite(deps, c.get('actor'), (await body(c, AcceptInviteInput)).token)));

  // --------------------------------------------------------------- sessions
  app.post('/campaigns/:cid/sessions', async (c) => c.json(await sessions.createSession(deps, c.get('actor'), id(c, 'cid'), await body(c, CreateSessionInput)), 201));
  app.post('/sessions/:sid/transition', async (c) => c.json(await sessions.transitionSession(deps, c.get('actor'), id(c, 'sid'), (await body(c, SessionTransitionInput)).action)));
  app.patch('/sessions/:sid', async (c) => {
    const input = await body(c, z.object({ title: plainText(80).optional(), meetingUrl: HttpsUrl.nullable().optional(), gmNotes: plainText(10000).optional() }));
    return c.json(await sessions.updateSessionDetails(deps, c.get('actor'), id(c, 'sid'), input));
  });
  app.get('/sessions/:sid/snapshot', async (c) => {
    const as = c.req.query('as');
    const view: sessions.SnapshotView = as === 'shared' ? 'shared' : as && /^[A-Za-z0-9-]{1,64}$/.test(as) ? { player: as } : 'auto';
    const scene = c.req.query('scene');
    return c.json(await sessions.getSessionSnapshot(deps, c.get('actor'), id(c, 'sid'), view, scene && IdParam.safeParse(scene).success ? scene : undefined));
  });
  app.get('/sessions/:sid/events', async (c) => {
    const since = Math.max(0, Number(c.req.query('since') ?? 0) | 0);
    return c.json(await sessions.getEventsSince(deps, c.get('actor'), id(c, 'sid'), since));
  });
  app.post('/commands', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AppError('INVALID_INPUT', 'Malformed command.');
    }
    return c.json(await executeCommand(deps, c.get('actor'), raw));
  });

  // ------------------------------------------------------------ maps/scenes
  app.post('/campaigns/:cid/maps/upload-intent', async (c) => c.json(await maps.uploadMapIntent(deps, c.get('actor'), id(c, 'cid'), await body(c, UploadMapIntentInput))));
  app.post('/campaigns/:cid/maps', async (c) => c.json(await maps.finalizeMap(deps, c.get('actor'), id(c, 'cid'), await body(c, FinalizeMapInput)), 201));
  app.get('/campaigns/:cid/maps/:mid', async (c) => c.json(await maps.getMap(deps, c.get('actor'), id(c, 'cid'), id(c, 'mid'))));
  app.patch('/campaigns/:cid/maps/:mid', async (c) => c.json(await maps.updateMap(deps, c.get('actor'), id(c, 'cid'), id(c, 'mid'), await body(c, UpdateMapInput))));
  app.post('/campaigns/:cid/scenes', async (c) => c.json(await maps.createScene(deps, c.get('actor'), id(c, 'cid'), await body(c, CreateSceneInput)), 201));
  app.patch('/campaigns/:cid/scenes/:scid', async (c) => c.json(await maps.updateScene(deps, c.get('actor'), id(c, 'cid'), id(c, 'scid'), await body(c, UpdateSceneInput))));

  // ------------------------------------------------- characters/inventory
  app.get('/campaigns/:cid/characters', async (c) => c.json(await characters.listCharacters(deps, c.get('actor'), id(c, 'cid'))));
  app.post('/campaigns/:cid/characters', async (c) => c.json(await characters.createCharacter(deps, c.get('actor'), id(c, 'cid'), await body(c, CreateCharacterInput)), 201));
  app.post('/campaigns/:cid/characters/import', async (c) => c.json(await characters.importCharacter(deps, c.get('actor'), id(c, 'cid'), await body(c, ImportCharacterInput)), 201));
  app.get('/campaigns/:cid/characters/:chid', async (c) => c.json(await characters.getCharacter(deps, c.get('actor'), id(c, 'cid'), id(c, 'chid'))));
  app.patch('/campaigns/:cid/characters/:chid', async (c) => c.json(await characters.updateCharacter(deps, c.get('actor'), id(c, 'cid'), id(c, 'chid'), await body(c, UpdateCharacterInput))));
  app.delete('/campaigns/:cid/characters/:chid', async (c) => {
    await characters.deleteCharacter(deps, c.get('actor'), id(c, 'cid'), id(c, 'chid'));
    return c.json({ ok: true });
  });
  app.get('/campaigns/:cid/characters/:chid/export', async (c) => c.json(await characters.exportCharacter(deps, c.get('actor'), id(c, 'cid'), id(c, 'chid'))));
  app.post('/campaigns/:cid/characters/:chid/items', async (c) => c.json(await characters.addItem(deps, c.get('actor'), id(c, 'cid'), id(c, 'chid'), await body(c, ItemInput)), 201));
  app.patch('/campaigns/:cid/characters/:chid/items/:iid', async (c) =>
    c.json(await characters.updateItem(deps, c.get('actor'), id(c, 'cid'), id(c, 'chid'), id(c, 'iid'), await body(c, ItemInput.partial()))),
  );
  app.delete('/campaigns/:cid/characters/:chid/items/:iid', async (c) => {
    await characters.deleteItem(deps, c.get('actor'), id(c, 'cid'), id(c, 'chid'), id(c, 'iid'));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------- creature library
  app.get('/campaigns/:cid/creatures', async (c) => c.json(await creatures.listCreatures(deps, c.get('actor'), id(c, 'cid'))));
  app.post('/campaigns/:cid/creatures', async (c) => c.json(await creatures.createCreature(deps, c.get('actor'), id(c, 'cid'), await body(c, CreatureInput)), 201));
  app.patch('/campaigns/:cid/creatures/:crid', async (c) => c.json(await creatures.updateCreature(deps, c.get('actor'), id(c, 'cid'), id(c, 'crid'), await body(c, CreatureInput))));
  app.delete('/campaigns/:cid/creatures/:crid', async (c) => {
    await creatures.deleteCreature(deps, c.get('actor'), id(c, 'cid'), id(c, 'crid'));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------- encounters
  app.get('/campaigns/:cid/encounters', async (c) => c.json(await encounters.listEncounters(deps, c.get('actor'), id(c, 'cid'))));
  app.post('/campaigns/:cid/encounters', async (c) => c.json(await encounters.createEncounter(deps, c.get('actor'), id(c, 'cid'), await body(c, EncounterInput)), 201));
  app.patch('/campaigns/:cid/encounters/:eid', async (c) => c.json(await encounters.updateEncounter(deps, c.get('actor'), id(c, 'cid'), id(c, 'eid'), await body(c, EncounterInput))));
  app.delete('/campaigns/:cid/encounters/:eid', async (c) => {
    await encounters.deleteEncounter(deps, c.get('actor'), id(c, 'cid'), id(c, 'eid'));
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- journal
  app.get('/campaigns/:cid/journal', async (c) => c.json(await journal.listJournal(deps, c.get('actor'), id(c, 'cid'))));
  app.post('/campaigns/:cid/journal', async (c) => c.json(await journal.createJournal(deps, c.get('actor'), id(c, 'cid'), await body(c, JournalInput)), 201));
  app.patch('/campaigns/:cid/journal/:jid', async (c) => c.json(await journal.updateJournal(deps, c.get('actor'), id(c, 'cid'), id(c, 'jid'), await body(c, JournalInput))));
  app.delete('/campaigns/:cid/journal/:jid', async (c) => {
    await journal.deleteJournal(deps, c.get('actor'), id(c, 'cid'), id(c, 'jid'));
    return c.json({ ok: true });
  });

  // ----------------------------------------------------------- chat history
  app.get('/campaigns/:cid/chat', async (c) => {
    const actor = c.get('actor');
    const ctx = await loadCampaign(deps, actor, id(c, 'cid'));
    const before = c.req.query('before');
    if (before !== undefined && !IdParam.safeParse(before).success) throw new AppError('INVALID_INPUT', 'Invalid cursor.');
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50) | 0));
    const messages = await visibleMessages(deps, ctx.campaign.id, actor.sub, ctx.access.isGM, limit + 1, before);
    // visibleMessages returns oldest-first; one extra row tells us whether more exist.
    const hasMore = messages.length > limit;
    return c.json({ messages: hasMore ? messages.slice(1) : messages, hasMore });
  });

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404));
  return app;
}

export type ApiApp = ReturnType<typeof createApp>;

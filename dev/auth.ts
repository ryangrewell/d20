/**
 * LOCAL DEVELOPMENT ONLY: a minimal emulator of the Cognito flows the app uses
 * (sign-up, email verification code, sign-in, password reset). Codes are
 * printed to the dev server console. Production uses Amazon Cognito.
 */
import { randomInt, randomUUID, scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '@shared/errors';
import { keys, type Db } from '@server/repo/db';
import { mintDevToken } from '@server/auth/verify';

type DevUser = { sub: string; email: string; displayName: string; passwordHash: string; salt: string; verified: boolean; code?: string; resetCode?: string; groups: string[] };

const Email = z.string().email().max(254).transform((e) => e.toLowerCase());
const Password = z.string().min(8, 'Use at least 8 characters').max(128);

function hash(password: string, salt: string) {
  return scryptSync(password, salt, 32).toString('hex');
}

const lastCodes = new Map<string, string>();

export function registerDevAuth(app: Hono<never>, db: Db, secret: string) {
  const parse = async <T extends z.ZodType>(req: Request, schema: T): Promise<z.output<T>> => {
    const r = schema.safeParse(await req.json().catch(() => ({})));
    if (!r.success) throw new AppError('INVALID_INPUT', r.error.issues[0]?.message ?? 'Invalid input');
    return r.data;
  };
  const sendCode = (email: string, code: string, purpose: string) => {
    lastCodes.set(email, code);
    console.log(`\n  [dev-auth] ${purpose} code for ${email}: ${code}\n`);
  };

  app.post('/dev/auth/sign-up', async (c) => {
    const input = await parse(c.req.raw, z.object({ email: Email, password: Password, displayName: z.string().trim().min(1).max(40) }));
    const salt = randomBytes(16).toString('hex');
    const code = String(randomInt(100000, 999999));
    const user: DevUser = { sub: randomUUID(), email: input.email, displayName: input.displayName, salt, passwordHash: hash(input.password, salt), verified: false, code, groups: [] };
    try {
      await db.put({ ...keys.devAuth(input.email), ...user }, { expr: 'attribute_not_exists(PK)' });
    } catch {
      throw new AppError('CONFLICT', 'An account with that email already exists.');
    }
    sendCode(input.email, code, 'Verification');
    return c.json({ ok: true, nextStep: 'CONFIRM_SIGN_UP' });
  });

  app.post('/dev/auth/confirm', async (c) => {
    const input = await parse(c.req.raw, z.object({ email: Email, code: z.string().trim() }));
    const user = await db.get<DevUser>(keys.devAuth(input.email));
    if (!user || user.code !== input.code) throw new AppError('INVALID_INPUT', 'That code is not valid.');
    await db.update({ Key: keys.devAuth(input.email), UpdateExpression: 'SET verified = :t REMOVE code', ExpressionAttributeValues: { ':t': true } });
    return c.json({ ok: true });
  });

  app.post('/dev/auth/resend', async (c) => {
    const input = await parse(c.req.raw, z.object({ email: Email }));
    const user = await db.get<DevUser>(keys.devAuth(input.email));
    if (user && !user.verified) {
      const code = String(randomInt(100000, 999999));
      await db.update({ Key: keys.devAuth(input.email), UpdateExpression: 'SET code = :c', ExpressionAttributeValues: { ':c': code } });
      sendCode(input.email, code, 'Verification');
    }
    return c.json({ ok: true });
  });

  app.post('/dev/auth/sign-in', async (c) => {
    const input = await parse(c.req.raw, z.object({ email: Email, password: z.string().max(128) }));
    const user = await db.get<DevUser>(keys.devAuth(input.email));
    const ok = !!user && timingSafeEqual(Buffer.from(hash(input.password, user.salt), 'hex'), Buffer.from(user.passwordHash, 'hex'));
    if (!ok) throw new AppError('UNAUTHENTICATED', 'Incorrect email or password.');
    if (!user.verified) throw new AppError('FORBIDDEN', 'Please verify your email first.', { nextStep: 'CONFIRM_SIGN_UP' });
    const idToken = await mintDevToken(secret, { sub: user.sub, email: user.email, name: user.displayName, groups: user.groups ?? [] });
    return c.json({ idToken, user: { sub: user.sub, email: user.email, displayName: user.displayName } });
  });

  // Always responds the same way so account existence is not revealed.
  app.post('/dev/auth/forgot', async (c) => {
    const input = await parse(c.req.raw, z.object({ email: Email }));
    const user = await db.get<DevUser>(keys.devAuth(input.email));
    if (user) {
      const code = String(randomInt(100000, 999999));
      await db.update({ Key: keys.devAuth(input.email), UpdateExpression: 'SET resetCode = :c', ExpressionAttributeValues: { ':c': code } });
      sendCode(input.email, code, 'Password reset');
    }
    return c.json({ ok: true });
  });

  app.post('/dev/auth/reset', async (c) => {
    const input = await parse(c.req.raw, z.object({ email: Email, code: z.string().trim(), newPassword: Password }));
    const user = await db.get<DevUser>(keys.devAuth(input.email));
    if (!user || !user.resetCode || user.resetCode !== input.code) throw new AppError('INVALID_INPUT', 'That code is not valid.');
    const salt = randomBytes(16).toString('hex');
    await db.update({
      Key: keys.devAuth(input.email),
      UpdateExpression: 'SET passwordHash = :h, salt = :s, verified = :t REMOVE resetCode',
      ExpressionAttributeValues: { ':h': hash(input.newPassword, salt), ':s': salt, ':t': true },
    });
    return c.json({ ok: true });
  });

  /** Test helper so Playwright can complete verification without reading the console. */
  app.get('/dev/auth/last-code', (c) => c.json({ code: lastCodes.get((c.req.query('email') ?? '').toLowerCase()) ?? null }));
}

export async function setDevGroups(db: Db, email: string, groups: string[]) {
  await db.update({ Key: keys.devAuth(email), UpdateExpression: 'SET #g = :g', ExpressionAttributeNames: { '#g': 'groups' }, ExpressionAttributeValues: { ':g': groups } });
}

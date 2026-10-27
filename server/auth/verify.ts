/**
 * Bearer-token verification. Production verifies Cognito ID tokens against the
 * user pool JWKS; local development verifies HS256 tokens minted by the dev
 * auth emulator (dev/auth.ts). Role claims in tokens are never trusted for
 * campaign permissions; only the Cognito `platform-admin` group is read, and
 * account status is always re-checked against the database.
 */
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import { AppError } from '@shared/errors';
import type { ServerConfig } from '../config';

export type VerifiedIdentity = { sub: string; email?: string; name?: string; groups: string[] };
export type TokenVerifier = (token: string) => Promise<VerifiedIdentity>;

export const PLATFORM_ADMIN_GROUP = 'platform-admin';

export function createVerifier(auth: ServerConfig['auth']): TokenVerifier {
  if (auth.mode === 'cognito') {
    const issuer = `https://cognito-idp.${auth.region}.amazonaws.com/${auth.userPoolId}`;
    const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    return async (token) => {
      try {
        const { payload } = await jwtVerify(token, jwks, { issuer, audience: auth.clientId });
        if (payload.token_use !== 'id') throw new Error('wrong token_use');
        return {
          sub: String(payload.sub),
          ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
          ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
          groups: Array.isArray(payload['cognito:groups']) ? (payload['cognito:groups'] as string[]) : [],
        };
      } catch {
        throw new AppError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
      }
    };
  }
  const key = new TextEncoder().encode(auth.secret);
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, key, { issuer: 'd20-dev', audience: 'd20-dev' });
      return {
        sub: String(payload.sub),
        ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
        ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
        groups: Array.isArray(payload.groups) ? (payload.groups as string[]) : [],
      };
    } catch {
      throw new AppError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
    }
  };
}

export async function mintDevToken(secret: string, id: VerifiedIdentity, ttlSeconds = 60 * 60 * 12): Promise<string> {
  return new SignJWT({ email: id.email, name: id.name, groups: id.groups })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(id.sub)
    .setIssuer('d20-dev')
    .setAudience('d20-dev')
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(secret));
}

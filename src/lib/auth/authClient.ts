/**
 * Auth abstraction over Amazon Cognito (production) and the local dev
 * emulator. Only the ID token is handed to the API; the API re-checks the
 * account and all permissions server-side.
 */
import { getRuntimeConfig } from '../config';

export type AuthUser = { sub: string; email: string; displayName: string };
export type SignInResult = { status: 'SIGNED_IN' } | { status: 'CONFIRM_SIGN_UP' };

export interface AuthClient {
  current(): Promise<AuthUser | null>;
  getIdToken(): Promise<string | null>;
  signUp(email: string, password: string, displayName: string): Promise<void>;
  confirmSignUp(email: string, code: string): Promise<void>;
  resendCode(email: string): Promise<void>;
  signIn(email: string, password: string): Promise<SignInResult>;
  signOut(): Promise<void>;
  forgotPassword(email: string): Promise<void>;
  resetPassword(email: string, code: string, newPassword: string): Promise<void>;
}

export class AuthFlowError extends Error {}

// ------------------------------------------------------------------- local

const STORAGE_KEY = 'd20.dev.session';

function decodeJwt(token: string): Record<string, unknown> {
  const part = token.split('.')[1] ?? '';
  return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
}

async function devPost(path: string, body: unknown) {
  const res = await fetch(`/api/dev/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: { message: string; details?: { nextStep?: string } } } & Record<string, unknown>;
  if (!res.ok) {
    const err = new AuthFlowError(json.error?.message ?? 'Request failed');
    (err as AuthFlowError & { nextStep?: string }).nextStep = json.error?.details?.nextStep;
    throw err;
  }
  return json;
}

export const devAuth: AuthClient = {
  async current() {
    const token = await this.getIdToken();
    if (!token) return null;
    const c = decodeJwt(token);
    return { sub: String(c.sub), email: String(c.email ?? ''), displayName: String(c.name ?? '') };
  },
  async getIdToken() {
    const token = sessionStorageSafe()?.getItem(STORAGE_KEY) ?? localStorageSafe()?.getItem(STORAGE_KEY);
    if (!token) return null;
    const exp = Number(decodeJwt(token).exp ?? 0) * 1000;
    if (exp < Date.now() + 30_000) {
      localStorageSafe()?.removeItem(STORAGE_KEY);
      return null;
    }
    return token;
  },
  async signUp(email, password, displayName) {
    await devPost('sign-up', { email, password, displayName });
  },
  async confirmSignUp(email, code) {
    await devPost('confirm', { email, code });
  },
  async resendCode(email) {
    await devPost('resend', { email });
  },
  async signIn(email, password) {
    try {
      const r = (await devPost('sign-in', { email, password })) as { idToken: string };
      localStorageSafe()?.setItem(STORAGE_KEY, r.idToken);
      return { status: 'SIGNED_IN' };
    } catch (e) {
      if ((e as { nextStep?: string }).nextStep === 'CONFIRM_SIGN_UP') return { status: 'CONFIRM_SIGN_UP' };
      throw e;
    }
  },
  async signOut() {
    localStorageSafe()?.removeItem(STORAGE_KEY);
  },
  async forgotPassword(email) {
    await devPost('forgot', { email });
  },
  async resetPassword(email, code, newPassword) {
    await devPost('reset', { email, code, newPassword });
  },
};

function localStorageSafe(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
function sessionStorageSafe(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- cognito

async function cognitoAuth(): Promise<AuthClient> {
  const [{ Amplify }, auth] = await Promise.all([import('aws-amplify'), import('aws-amplify/auth')]);
  const cfg = getRuntimeConfig();
  if (cfg.mode !== 'amplify') throw new Error('Cognito auth requires amplify mode');
  Amplify.configure(cfg.outputs as Parameters<typeof Amplify.configure>[0]);
  const events = (cfg.outputs.custom as { events?: { url: string; aws_region: string } } | undefined)?.events;
  if (events) {
    const existing = Amplify.getConfig();
    Amplify.configure({ ...existing, API: { ...existing.API, Events: { endpoint: events.url, region: events.aws_region, defaultAuthMode: 'userPool' } } });
  }
  const wrap = async <T,>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (e) {
      throw new AuthFlowError((e as Error).message);
    }
  };
  return {
    async current() {
      try {
        const s = await auth.fetchAuthSession();
        const c = s.tokens?.idToken?.payload;
        if (!c) return null;
        return { sub: String(c.sub), email: String(c.email ?? ''), displayName: String(c.name ?? '') };
      } catch {
        return null;
      }
    },
    async getIdToken() {
      try {
        return (await auth.fetchAuthSession()).tokens?.idToken?.toString() ?? null;
      } catch {
        return null;
      }
    },
    signUp: (email, password, displayName) => wrap(async () => void (await auth.signUp({ username: email, password, options: { userAttributes: { email, name: displayName } } }))),
    confirmSignUp: (email, code) => wrap(async () => void (await auth.confirmSignUp({ username: email, confirmationCode: code }))),
    resendCode: (email) => wrap(async () => void (await auth.resendSignUpCode({ username: email }))),
    signIn: (email, password) =>
      wrap(async () => {
        const r = await auth.signIn({ username: email, password });
        if (r.nextStep.signInStep === 'CONFIRM_SIGN_UP') return { status: 'CONFIRM_SIGN_UP' as const };
        if (!r.isSignedIn) throw new AuthFlowError('Additional sign-in steps are required for this account.');
        return { status: 'SIGNED_IN' as const };
      }),
    signOut: () => wrap(() => auth.signOut()),
    forgotPassword: (email) =>
      wrap(async () => {
        // Same response whether or not the account exists.
        await auth.resetPassword({ username: email }).catch(() => undefined);
      }),
    resetPassword: (email, code, newPassword) => wrap(() => auth.confirmResetPassword({ username: email, confirmationCode: code, newPassword })),
  };
}

let client: AuthClient | null = null;
export async function getAuthClient(): Promise<AuthClient> {
  if (client) return client;
  client = getRuntimeConfig().mode === 'amplify' ? await cognitoAuth() : devAuth;
  return client;
}

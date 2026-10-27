import type { ErrorCode } from '@shared/errors';
import { getRuntimeConfig } from '../config';
import { getAuthClient } from '../auth/authClient';

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(fn: () => void) {
  onUnauthenticated = fn;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const token = await (await getAuthClient()).getIdToken();
  let res: Response;
  try {
    res = await fetch(`${getRuntimeConfig().apiBase}${path}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch {
    throw new ApiError('NETWORK', 'Could not reach the server. Check your connection.', 0);
  }
  const json = (await res.json().catch(() => null)) as ({ error?: { code: ErrorCode; message: string; details?: Record<string, unknown> } } & T) | null;
  if (!res.ok) {
    const e = json?.error;
    if (res.status === 401) onUnauthenticated?.();
    const accountStatus = e?.details?.accountStatus;
    if (res.status === 403 && typeof accountStatus === 'string') window.dispatchEvent(new CustomEvent('d20:account-status', { detail: { status: accountStatus, message: e?.message ?? '' } }));
    throw new ApiError(e?.code ?? 'INTERNAL', e?.message ?? `Request failed (${res.status})`, res.status, e?.details);
  }
  return json as T;
}

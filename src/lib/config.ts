/**
 * Runtime configuration. In `local` mode the app talks to the dev server via
 * the Vite proxy. In `amplify` mode it reads the public amplify_outputs.json
 * produced by the Amplify Gen 2 deployment (contains only public IDs/URLs).
 */
export type RuntimeConfig =
  | { mode: 'local'; apiBase: string; wsUrl: string }
  | { mode: 'amplify'; apiBase: string; outputs: Record<string, unknown> & { custom?: { apiUrl?: string } } };

let cached: RuntimeConfig | null = null;

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (cached) return cached;
  const mode = (import.meta.env.VITE_BACKEND_MODE as string | undefined) ?? 'local';
  if (mode === 'amplify') {
    const res = await fetch('/amplify_outputs.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('Backend configuration is missing. The deployment may be incomplete.');
    const outputs = (await res.json()) as RuntimeConfig extends infer _ ? Record<string, unknown> & { custom?: { apiUrl?: string } } : never;
    const apiBase = (outputs.custom?.apiUrl ?? '').replace(/\/$/, '') + '/api';
    cached = { mode: 'amplify', apiBase, outputs };
  } else {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    cached = { mode: 'local', apiBase: '/api', wsUrl: `${proto}://${location.host}/ws` };
  }
  return cached;
}

export function getRuntimeConfig(): RuntimeConfig {
  if (!cached) throw new Error('Runtime config not loaded');
  return cached;
}

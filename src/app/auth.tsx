import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { getAuthClient, type AuthUser } from '@/lib/auth/authClient';
import { setUnauthenticatedHandler } from '@/lib/api/client';
import { Spinner } from '@/components/ui/primitives';

type AuthState = { user: AuthUser | null; loading: boolean; refresh: () => Promise<void>; signOut: () => Promise<void> };

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    const client = await getAuthClient();
    setUser(await client.current());
    setLoading(false);
  }, []);

  const signOut = useCallback(async () => {
    await (await getAuthClient()).signOut();
    qc.clear();
    setUser(null);
  }, [qc]);

  useEffect(() => {
    void refresh();
    setUnauthenticatedHandler(() => void refresh());
  }, [refresh]);

  const value = useMemo(() => ({ user, loading, refresh, signOut }), [user, loading, refresh, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** Sends signed-out users to sign-in, preserving where they were going (e.g. an invite link). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading)
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  if (!user) return <Navigate to={`/sign-in?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

export function safeNext(next: string | null): string {
  // Only allow same-origin relative paths to avoid open redirects.
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

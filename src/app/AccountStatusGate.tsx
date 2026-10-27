import { useEffect, useState, type ReactNode } from 'react';
import { Ban } from 'lucide-react';
import { useAuth } from './auth';
import { Button } from '@/components/ui/primitives';

/** Shown instead of the app when the server says this account is blocked or suspended. */
export function AccountStatusGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<{ status: string; message: string } | null>(null);
  const { signOut } = useAuth();
  useEffect(() => {
    const on = (e: Event) => setStatus((e as CustomEvent<{ status: string; message: string }>).detail);
    window.addEventListener('d20:account-status', on);
    return () => window.removeEventListener('d20:account-status', on);
  }, []);
  if (!status) return <>{children}</>;
  return (
    <div className="grid h-full place-items-center bg-atmosphere px-4 text-center">
      <div className="max-w-md">
        <Ban className="mx-auto h-10 w-10 text-danger" aria-hidden />
        <h1 className="mt-4 font-display text-2xl font-bold">{status.status === 'BLOCKED' ? 'Account blocked' : 'Account suspended'}</h1>
        <p className="mt-2 text-muted">{status.message} If you think this is a mistake, contact the site owner.</p>
        <Button
          className="mt-6"
          variant="outline"
          onClick={async () => {
            await signOut();
            setStatus(null);
            location.href = '/';
          }}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}

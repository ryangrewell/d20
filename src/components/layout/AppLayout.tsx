import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LogOut, UserRound } from 'lucide-react';
import { useAuth } from '@/app/auth';
import { useIsAdmin } from '@/features/admin/useIsAdmin';
import { Button } from '@/components/ui/primitives';

export function Logo({ className = '' }: { className?: string }) {
  return (
    <Link to="/" className={`flex items-center gap-2 font-display text-xl font-bold tracking-wider ${className}`}>
      <img src="/favicon.svg" alt="" className="h-7 w-7" />
      <span>d20</span>
    </Link>
  );
}

export function AppLayout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  return (
    <div className="min-h-full bg-atmosphere">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-bg/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <Logo />
            <nav className="hidden gap-1 sm:flex">
              <NavLink to="/dashboard" className={({ isActive }) => `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-surface-2 text-text' : 'text-muted hover:text-text'}`}>
                Campaigns
              </NavLink>
              {isAdmin.data && (
                <NavLink to="/admin" className={({ isActive }) => `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-surface-2 text-text' : 'text-muted hover:text-text'}`}>
                  Admin
                </NavLink>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/account" className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted hover:text-text">
              <UserRound className="h-4 w-4" aria-hidden />
              <span className="max-w-40 truncate">{user?.displayName || user?.email}</span>
            </Link>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await signOut();
                navigate('/');
              }}
            >
              <LogOut className="h-4 w-4" aria-hidden /> Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}

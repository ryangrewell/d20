/**
 * Platform administration. Every call is re-authorised server-side against the
 * identity provider; this UI only renders what the admin API returns.
 */
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Flag, Gauge, ScrollText, Search, ShieldOff, Swords, UserCheck, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { Badge, Button, Card, EmptyState, ErrorNotice, Field, Input, Select, Spinner, cn } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';
import { useIsAdmin } from './useIsAdmin';

type UserRow = { sub: string; displayName: string; email: string | null; status: 'ACTIVE' | 'SUSPENDED' | 'BLOCKED'; suspendedUntil: string | null; createdAt: string; lastActiveAt: string | null; isAdmin?: boolean };
type AuditRow = { id: string; at: string; actorSub: string; action: string; targetType: string; targetId: string; reason?: string; outcome: string; metadata?: Record<string, unknown> };
type Metrics = {
  users: Record<'total' | 'new7' | 'new30' | 'active7' | 'active30' | 'suspended' | 'blocked', number>;
  campaigns: { total: number; active30: number; liveSessions: number };
  storage: { bytes: number; uploads: number };
  reports: { open: number };
  recentUsers: UserRow[];
  recentAudit: AuditRow[];
};
type CampaignRow = { id: string; title: string; ownerName: string; systemId: string; status: string; createdAt: string; updatedAt: string; memberCount: number; live: boolean };
type Report = { id: string; reporterName: string; targetType: string; subjectName?: string; subjectSub?: string; campaignTitle: string; reason: string; details: string; excerpt?: string; status: string; disposition?: string; createdAt: string };

type Tab = 'overview' | 'users' | 'campaigns' | 'reports' | 'audit';
const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : '—');
const STATUS_TONE = { ACTIVE: 'success', SUSPENDED: 'accent', BLOCKED: 'danger' } as const;

export default function AdminPage() {
  const isAdmin = useIsAdmin();
  const [tab, setTab] = useState<Tab>('overview');
  if (isAdmin.isLoading) return <Spinner label="Checking access" />;
  if (!isAdmin.data) return <Navigate to="/dashboard" replace />;
  const tabs: { id: Tab; label: string; icon: typeof Gauge }[] = [
    { id: 'overview', label: 'Overview', icon: Gauge },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'campaigns', label: 'Campaigns', icon: Swords },
    { id: 'reports', label: 'Reports', icon: Flag },
    { id: 'audit', label: 'Audit log', icon: ScrollText },
  ];
  return (
    <div>
      <h1 className="font-display text-3xl font-bold">Platform admin</h1>
      <p className="mt-1 text-sm text-muted">Summaries only. Private campaign content, GM notes and whispers are never shown here. Every action is audited.</p>
      <div role="tablist" className="scrollbar-thin mt-6 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn('-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm', tab === t.id ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text')}>
            <t.icon className="h-4 w-4" aria-hidden /> {t.label}
          </button>
        ))}
      </div>
      <div className="mt-6">
        {tab === 'overview' && <Overview />}
        {tab === 'users' && <UsersTab />}
        {tab === 'campaigns' && <CampaignsTab />}
        {tab === 'reports' && <ReportsTab />}
        {tab === 'audit' && <AuditTab />}
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs uppercase tracking-wider text-faint">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold">{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </Card>
  );
}

function Overview() {
  const m = useQuery({ queryKey: ['admin', 'metrics'], queryFn: () => api<Metrics>('/admin/metrics') });
  if (m.isLoading) return <Spinner />;
  if (m.error) return <ErrorNotice error={m.error} />;
  const d = m.data!;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Users" value={d.users.total} sub={`+${d.users.new7} this week · +${d.users.new30} this month`} />
        <Tile label="Active users" value={d.users.active7} sub={`7 days · ${d.users.active30} in 30 days`} />
        <Tile label="Campaigns" value={d.campaigns.total} sub={`${d.campaigns.active30} active · ${d.campaigns.liveSessions} live now`} />
        <Tile label="Open reports" value={d.reports.open} sub={`${d.users.suspended} suspended · ${d.users.blocked} blocked`} />
        <Tile label="Map storage" value={`${(d.storage.bytes / 1024 / 1024).toFixed(1)} MB`} sub={`${d.storage.uploads} uploads`} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-2 font-semibold">Recent sign-ups</h2>
          <ul className="space-y-1 text-sm">
            {d.recentUsers.map((u) => (
              <li key={u.sub} className="flex justify-between gap-2">
                <span className="truncate">{u.displayName}</span>
                <span className="shrink-0 text-xs text-faint">{fmtDate(u.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-4">
          <h2 className="mb-2 font-semibold">Recent admin activity</h2>
          <AuditList rows={d.recentAudit} />
        </Card>
      </div>
    </div>
  );
}

function AuditList({ rows }: { rows: AuditRow[] }) {
  if (!rows.length) return <p className="text-sm text-faint">Nothing yet.</p>;
  return (
    <ul className="space-y-1.5 text-xs">
      {rows.map((a) => (
        <li key={a.id} className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-faint">{fmtDate(a.at)}</span>
          <Badge tone={a.outcome === 'DENIED' ? 'danger' : 'neutral'}>{a.action.replace(/_/g, ' ').toLowerCase()}</Badge>
          <span className="text-muted">
            {a.targetType.toLowerCase()} {a.targetId.slice(0, 10)}…
          </span>
          {a.reason && <span className="w-full text-muted">“{a.reason}”</span>}
        </li>
      ))}
    </ul>
  );
}

function UsersTab() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const users = useQuery({ queryKey: ['admin', 'users', query], queryFn: () => api<UserRow[]>(`/admin/users?q=${encodeURIComponent(query)}`) });
  return (
    <div className="space-y-4">
      <form
        className="flex max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q);
        }}
      >
        <Input aria-label="Search users" placeholder="Name, email or account id" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="secondary">
          <Search className="h-4 w-4" aria-hidden /> Search
        </Button>
      </form>
      {users.isLoading && <Spinner />}
      {users.error && <ErrorNotice error={users.error} />}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wider text-faint">
            <tr>
              <th className="py-2 pr-4">User</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Joined</th>
              <th className="py-2 pr-4">Last active</th>
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.sub} className="cursor-pointer border-t border-border hover:bg-surface-2" onClick={() => setOpen(u.sub)}>
                <td className="py-2 pr-4">
                  <div className="font-medium">
                    {u.displayName} {u.isAdmin && <Badge tone="accent">admin</Badge>}
                  </div>
                  <div className="text-xs text-faint">{u.email ?? u.sub}</div>
                </td>
                <td className="py-2 pr-4">
                  <Badge tone={STATUS_TONE[u.status]}>{u.status.toLowerCase()}</Badge>
                </td>
                <td className="py-2 pr-4 text-xs text-muted">{fmtDate(u.createdAt)}</td>
                <td className="py-2 pr-4 text-xs text-muted">{fmtDate(u.lastActiveAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <UserDialog sub={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function UserDialog({ sub, onClose }: { sub: string; onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['admin', 'user', sub], queryFn: () => api<{ user: UserRow; campaigns: { campaignId: string; title: string; role: string; status: string }[]; history: AuditRow[] }>(`/admin/users/${sub}`) });
  const [action, setAction] = useState<'suspend' | 'block' | 'unblock' | 'revoke-admin' | null>(null);
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState(new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!action) return;
    setBusy(true);
    try {
      await api(`/admin/users/${sub}/${action}`, { body: { reason, ...(action === 'suspend' ? { until: new Date(`${until}T23:59:59`).toISOString() } : {}) } });
      toast.success('Done. Recorded in the audit log.');
      setAction(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const u = detail.data?.user;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={u?.displayName ?? 'User'} description={u ? `${u.email ?? ''} · ${u.sub}` : undefined} wide>
      {detail.isLoading && <Spinner />}
      {detail.error && <ErrorNotice error={detail.error} />}
      {u && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={STATUS_TONE[u.status]}>{u.status.toLowerCase()}</Badge>
            {u.suspendedUntil && <span className="text-xs text-muted">until {fmtDate(u.suspendedUntil)}</span>}
            {u.isAdmin && <Badge tone="accent">platform admin</Badge>}
            <span className="text-xs text-faint">Joined {fmtDate(u.createdAt)} · last active {fmtDate(u.lastActiveAt)}</span>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-semibold">Campaigns ({detail.data!.campaigns.length})</h3>
            <ul className="space-y-1 text-sm">
              {detail.data!.campaigns.map((c) => (
                <li key={c.campaignId} className="flex items-center gap-2">
                  <span className="flex-1 truncate">{c.title}</span>
                  <Badge>{c.role.toLowerCase()}</Badge>
                  {c.status !== 'ACTIVE' && <Badge tone="danger">{c.status.toLowerCase()}</Badge>}
                  {c.status === 'ACTIVE' && c.role !== 'OWNER' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const why = prompt(`Reason for removing ${u.displayName} from ${c.title}? (kept in the audit log)`);
                        if (!why) return;
                        try {
                          await api(`/admin/campaigns/${c.campaignId}/members/${sub}/remove`, { body: { reason: why } });
                          toast.success('Removed from campaign');
                          void qc.invalidateQueries({ queryKey: ['admin'] });
                        } catch (e) {
                          toast.error((e as Error).message);
                        }
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-wrap gap-2">
            {u.status !== 'SUSPENDED' && u.status !== 'BLOCKED' && (
              <Button size="sm" variant="secondary" onClick={() => setAction('suspend')}>
                Suspend…
              </Button>
            )}
            {u.status !== 'BLOCKED' && (
              <Button size="sm" variant="danger" onClick={() => setAction('block')}>
                <Ban className="h-4 w-4" aria-hidden /> Block…
              </Button>
            )}
            {u.status !== 'ACTIVE' && (
              <Button size="sm" variant="secondary" onClick={() => setAction('unblock')}>
                <UserCheck className="h-4 w-4" aria-hidden /> Restore access…
              </Button>
            )}
            {u.isAdmin && (
              <Button size="sm" variant="ghost" onClick={() => setAction('revoke-admin')}>
                <ShieldOff className="h-4 w-4" aria-hidden /> Revoke admin…
              </Button>
            )}
          </div>
          {action && (
            <form
              className="space-y-3 rounded-lg border border-border p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run();
              }}
            >
              {action === 'suspend' && (
                <Field label="Suspended until" htmlFor="aUntil">
                  <Input id="aUntil" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
                </Field>
              )}
              <Field label="Reason (recorded in the audit log)" htmlFor="aReason">
                <Input id="aReason" autoFocus value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setAction(null)}>
                  Cancel
                </Button>
                <Button type="submit" variant={action === 'block' ? 'danger' : 'primary'} disabled={reason.trim().length < 3} loading={busy}>
                  {action === 'suspend' ? 'Suspend' : action === 'block' ? 'Block and sign out' : action === 'unblock' ? 'Restore access' : 'Revoke admin'}
                </Button>
              </div>
            </form>
          )}
          <div>
            <h3 className="mb-1 text-sm font-semibold">History</h3>
            <AuditList rows={detail.data!.history} />
          </div>
        </div>
      )}
    </Dialog>
  );
}

function CampaignsTab() {
  const list = useQuery({ queryKey: ['admin', 'campaigns'], queryFn: () => api<CampaignRow[]>('/admin/campaigns') });
  if (list.isLoading) return <Spinner />;
  if (list.error) return <ErrorNotice error={list.error} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wider text-faint">
          <tr>
            <th className="py-2 pr-4">Campaign</th>
            <th className="py-2 pr-4">Owner</th>
            <th className="py-2 pr-4">Players</th>
            <th className="py-2 pr-4">Created</th>
            <th className="py-2 pr-4">Last activity</th>
          </tr>
        </thead>
        <tbody>
          {list.data!.map((c) => (
            <tr key={c.id} className="border-t border-border">
              <td className="py-2 pr-4">
                <span className="font-medium">{c.title}</span> {c.live && <Badge tone="success">live</Badge>} {c.status === 'ARCHIVED' && <Badge>archived</Badge>}
                <div className="text-xs text-faint">{c.systemId}</div>
              </td>
              <td className="py-2 pr-4">{c.ownerName}</td>
              <td className="py-2 pr-4">{c.memberCount}</td>
              <td className="py-2 pr-4 text-xs text-muted">{fmtDate(c.createdAt)}</td>
              <td className="py-2 pr-4 text-xs text-muted">{fmtDate(c.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportsTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'OPEN' | 'RESOLVED' | 'ALL'>('OPEN');
  const list = useQuery({ queryKey: ['admin', 'reports', status], queryFn: () => api<Report[]>(`/admin/reports?status=${status}`) });
  const resolve = async (r: Report, disposition: string) => {
    const note = prompt('Note for the audit log (optional)') ?? '';
    try {
      await api(`/admin/reports/${r.id}/resolve`, { body: { disposition, note } });
      toast.success('Report resolved');
      void qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      <Select aria-label="Report status" className="w-48" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
        <option value="OPEN">Open</option>
        <option value="RESOLVED">Resolved</option>
        <option value="ALL">All</option>
      </Select>
      {list.isLoading && <Spinner />}
      {list.error && <ErrorNotice error={list.error} />}
      {list.data?.length === 0 && <EmptyState icon={<Flag className="h-8 w-8" />} title="No reports">Nothing needs attention.</EmptyState>}
      <div className="space-y-3">
        {list.data?.map((r) => (
          <Card key={r.id} className="p-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={r.status === 'OPEN' ? 'danger' : 'neutral'}>{r.status.toLowerCase()}</Badge>
              <span className="font-medium">{r.reason.replace(/_/g, ' ').toLowerCase()}</span>
              <span className="text-muted">
                {r.targetType.toLowerCase()}
                {r.subjectName ? ` by ${r.subjectName}` : ''} in {r.campaignTitle}
              </span>
              <span className="ml-auto text-xs text-faint">
                reported by {r.reporterName} · {fmtDate(r.createdAt)}
              </span>
            </div>
            {r.excerpt && <blockquote className="mt-2 border-l-2 border-border pl-3 text-sm text-muted">{r.excerpt}</blockquote>}
            {r.details && <p className="mt-2 text-sm">{r.details}</p>}
            {r.disposition && <p className="mt-2 text-xs text-faint">Resolved: {r.disposition.replace(/_/g, ' ').toLowerCase()}</p>}
            {r.status === 'OPEN' && (
              <div className="mt-3 flex flex-wrap gap-2">
                {['NO_ACTION', 'WARNED', 'CONTENT_REMOVED', 'USER_SUSPENDED', 'USER_BLOCKED'].map((d) => (
                  <Button key={d} size="sm" variant="secondary" onClick={() => void resolve(r, d)}>
                    {d.replace(/_/g, ' ').toLowerCase()}
                  </Button>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>
      <p className="text-xs text-faint">Resolving records the outcome. To actually suspend or block, use the Users tab (both steps are audited).</p>
    </div>
  );
}

function AuditTab() {
  const list = useQuery({ queryKey: ['admin', 'audit'], queryFn: () => api<AuditRow[]>('/admin/audit') });
  if (list.isLoading) return <Spinner />;
  if (list.error) return <ErrorNotice error={list.error} />;
  return (
    <Card className="p-4">
      <AuditList rows={list.data!} />
    </Card>
  );
}

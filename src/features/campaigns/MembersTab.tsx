import { useState } from 'react';
import { Copy, Crown, Link2, Trash2, UserMinus } from 'lucide-react';
import { toast } from 'sonner';
import type { CampaignDashboardDto } from '@shared/dto';
import { campaignApi, qk, useCampaignMutation, useInvites } from '@/lib/api/hooks';
import { useAuth } from '@/app/auth';
import { Badge, Button, Card, Field, Select } from '@/components/ui/primitives';

export function MembersTab({ data }: { data: CampaignDashboardDto }) {
  const { campaign, access, members } = data;
  const { user } = useAuth();
  const invites = useInvites(campaign.id, access.isOwner);
  const remove = useCampaignMutation(campaign.id, (sub: string) => campaignApi.removeMember(campaign.id, sub));
  const revoke = useCampaignMutation(campaign.id, (id: string) => campaignApi.revokeInvite(campaign.id, id), [[...qk.invites(campaign.id)]]);
  const [maxUses, setMaxUses] = useState('');
  const [expires, setExpires] = useState('168');
  const [lastLink, setLastLink] = useState<string | null>(null);
  const create = useCampaignMutation(
    campaign.id,
    () => campaignApi.createInvite(campaign.id, { ...(maxUses ? { maxUses: Number(maxUses) } : {}), ...(expires ? { expiresInHours: Number(expires) } : {}) }),
    [[...qk.invites(campaign.id)]],
  );

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Invite link copied');
    } catch {
      toast.message('Copy the link manually');
    }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
      <section>
        <h2 className="mb-3 font-display text-lg font-semibold">At the table</h2>
        <div className="space-y-2">
          {members.map((m) => (
            <Card key={m.userSub} className="flex items-center justify-between p-3">
              <div className="flex items-center gap-3">
                <span className="h-3 w-3 rounded-full" style={{ background: m.color }} aria-hidden />
                <span className="font-medium">{m.displayName}</span>
                {m.userSub === user?.sub && <span className="text-xs text-faint">(you)</span>}
                {m.role === 'OWNER' ? (
                  <Badge tone="accent">
                    <Crown className="h-3 w-3" aria-hidden /> GM
                  </Badge>
                ) : (
                  <Badge>{m.role === 'SPECTATOR' ? 'Spectator' : 'Player'}</Badge>
                )}
              </div>
              {access.isOwner && m.role !== 'OWNER' && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${m.displayName}`}
                  onClick={() => {
                    if (confirm(`Remove ${m.displayName} from this campaign? They will lose access immediately.`))
                      remove.mutate(m.userSub, { onSuccess: () => toast.success(`${m.displayName} was removed`), onError: (e) => toast.error((e as Error).message) });
                  }}
                >
                  <UserMinus className="h-4 w-4" aria-hidden /> Remove
                </Button>
              )}
            </Card>
          ))}
        </div>
      </section>

      {access.isOwner && campaign.status === 'ACTIVE' && (
        <section>
          <h2 className="mb-3 font-display text-lg font-semibold">Invite players</h2>
          <Card className="space-y-4 p-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Uses" htmlFor="maxUses">
                <Select id="maxUses" value={maxUses} onChange={(e) => setMaxUses(e.target.value)}>
                  <option value="">Unlimited</option>
                  <option value="1">Single use</option>
                  <option value="5">5 uses</option>
                  <option value="10">10 uses</option>
                </Select>
              </Field>
              <Field label="Expires" htmlFor="expires">
                <Select id="expires" value={expires} onChange={(e) => setExpires(e.target.value)}>
                  <option value="24">In 1 day</option>
                  <option value="168">In 7 days</option>
                  <option value="720">In 30 days</option>
                  <option value="">Never</option>
                </Select>
              </Field>
            </div>
            <Button
              className="w-full justify-center"
              loading={create.isPending}
              onClick={() =>
                create.mutate(undefined, {
                  onSuccess: (r) => {
                    const link = `${location.origin}/invite/${r.token}`;
                    setLastLink(link);
                    void copy(link);
                  },
                  onError: (e) => toast.error((e as Error).message),
                })
              }
            >
              <Link2 className="h-4 w-4" aria-hidden /> Create invite link
            </Button>
            {lastLink && (
              <div className="rounded-lg bg-surface-2 p-3">
                <p className="text-xs text-muted">Share this link. For security it is shown only once.</p>
                <div className="mt-2 flex gap-2">
                  <input readOnly value={lastLink} aria-label="Invite link" className="min-w-0 flex-1 rounded-md bg-bg px-2 py-1 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                  <Button size="sm" variant="secondary" onClick={() => void copy(lastLink)} aria-label="Copy invite link">
                    <Copy className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </div>
            )}
          </Card>
          <h3 className="mb-2 mt-6 text-sm font-semibold text-muted">Invite links</h3>
          <div className="space-y-2">
            {(invites.data ?? []).map((inv) => (
              <div key={inv.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-xs">
                <div>
                  <Badge tone={inv.status === 'ACTIVE' ? 'success' : 'neutral'}>{inv.status.replace('_', ' ').toLowerCase()}</Badge>
                  <span className="ml-2 text-muted">
                    {inv.useCount}
                    {inv.maxUses ? `/${inv.maxUses}` : ''} used{inv.expiresAt ? ` · expires ${new Date(inv.expiresAt).toLocaleDateString()}` : ''}
                  </span>
                </div>
                {inv.status === 'ACTIVE' && (
                  <Button size="sm" variant="ghost" aria-label="Revoke invite" onClick={() => revoke.mutate(inv.id)}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                )}
              </div>
            ))}
            {invites.data?.length === 0 && <p className="text-xs text-faint">No invite links yet.</p>}
          </div>
        </section>
      )}
    </div>
  );
}

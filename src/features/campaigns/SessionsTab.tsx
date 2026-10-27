import { Link } from 'react-router-dom';
import { CalendarClock, Hourglass, Play, Plus, Square } from 'lucide-react';
import { toast } from 'sonner';
import type { CampaignDashboardDto } from '@shared/dto';
import { campaignApi, useCampaignMutation } from '@/lib/api/hooks';
import { Badge, Button, Card, EmptyState } from '@/components/ui/primitives';

const STATUS_TONE = { PLANNED: 'info', LIVE: 'success', PAUSED: 'accent', ENDED: 'neutral' } as const;
const STATUS_LABEL = { PLANNED: 'Planned', LIVE: 'Live', PAUSED: 'Paused', ENDED: 'Ended' } as const;

export function SessionsTab({ data }: { data: CampaignDashboardDto }) {
  const { campaign, access, sessions } = data;
  const create = useCampaignMutation(campaign.id, () => campaignApi.createSession(campaign.id, {}));
  const transition = useCampaignMutation(campaign.id, (v: { id: string; action: 'start' | 'end' }) => campaignApi.transition(v.id, v.action));
  const archived = campaign.status === 'ARCHIVED';

  const act = (id: string, action: 'start' | 'end') =>
    transition.mutate({ id, action }, { onError: (e) => toast.error((e as Error).message), onSuccess: () => toast.success(action === 'start' ? 'Session is live' : 'Session ended. Everything is saved.') });

  return (
    <div className="space-y-4">
      {access.isGM && !archived && (
        <div className="flex justify-end">
          <Button onClick={() => create.mutate(undefined, { onError: (e) => toast.error((e as Error).message) })} loading={create.isPending}>
            <Plus className="h-4 w-4" aria-hidden /> New session
          </Button>
        </div>
      )}
      {sessions.length === 0 ? (
        <EmptyState icon={<CalendarClock className="h-8 w-8" />} title="No sessions yet">
          {access.isGM
            ? 'Create a session to prepare your table. Players can join once you start it.'
            : 'Your GM has not scheduled a session yet. You will be able to join here once one starts.'}
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {sessions.map((s) => {
            const open = s.status !== 'ENDED' && (access.isGM || s.status === 'LIVE' || s.status === 'PAUSED');
            return (
              <Card key={s.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{s.title}</span>
                    <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-faint">
                    Session {s.number}
                    {s.startedAt && ` · started ${new Date(s.startedAt).toLocaleString()}`}
                    {s.endedAt && ` · ended ${new Date(s.endedAt).toLocaleString()}`}
                  </p>
                </div>
                <div className="flex gap-2">
                  {access.isGM && s.status === 'PLANNED' && (
                    <Button variant="secondary" size="sm" onClick={() => act(s.id, 'start')}>
                      <Play className="h-4 w-4" aria-hidden /> Start
                    </Button>
                  )}
                  {access.isGM && (s.status === 'LIVE' || s.status === 'PAUSED') && (
                    <Button variant="outline" size="sm" onClick={() => act(s.id, 'end')}>
                      <Square className="h-4 w-4" aria-hidden /> End
                    </Button>
                  )}
                  {open ? (
                    <Link to={`/campaigns/${campaign.id}/sessions/${s.id}`}>
                      <Button size="sm">{access.isGM ? (s.status === 'PLANNED' ? 'Prepare table' : 'Open table') : 'Join table'}</Button>
                    </Link>
                  ) : (
                    !access.isGM &&
                    s.status === 'PLANNED' && (
                      <span className="flex items-center gap-1 text-xs text-muted">
                        <Hourglass className="h-3 w-3" aria-hidden /> Waiting for the GM
                      </span>
                    )
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

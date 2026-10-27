import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Crown, MapIcon, Play, Settings, Skull, UserRound, Users, Video } from 'lucide-react';
import { useCampaign } from '@/lib/api/hooks';
import { Badge, Button, ErrorNotice, Spinner, cn } from '@/components/ui/primitives';
import { SessionsTab } from './SessionsTab';
import { MapsTab } from './MapsTab';
import { MembersTab } from './MembersTab';
import { SettingsTab } from './SettingsTab';
import { CharactersTab } from './CharactersTab';
import { CreaturesTab } from './CreaturesTab';

type Tab = 'sessions' | 'characters' | 'maps' | 'creatures' | 'members' | 'settings';

export function CampaignPage() {
  const { campaignId = '' } = useParams();
  const { data, isLoading, error, refetch } = useCampaign(campaignId);
  const [tab, setTab] = useState<Tab>('sessions');
  const navigate = useNavigate();

  if (isLoading) return <Spinner label="Loading campaign" />;
  if (error)
    return (
      <div className="max-w-lg">
        <ErrorNotice error={error} onRetry={() => void refetch()} />
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/dashboard')}>
          Back to campaigns
        </Button>
      </div>
    );
  if (!data) return null;
  const { campaign, access } = data;
  const live = data.sessions.find((s) => s.status === 'LIVE' || s.status === 'PAUSED');

  const tabs: { id: Tab; label: string; icon: typeof Play; gmOnly?: boolean }[] = [
    { id: 'sessions', label: 'Sessions', icon: Play },
    { id: 'characters', label: 'Characters', icon: UserRound },
    { id: 'maps', label: 'Maps & scenes', icon: MapIcon, gmOnly: true },
    { id: 'creatures', label: 'Creatures', icon: Skull, gmOnly: true },
    { id: 'members', label: 'Players', icon: Users },
    { id: 'settings', label: 'Settings', icon: Settings, gmOnly: true },
  ];

  return (
    <div>
      <Link to="/dashboard" className="text-sm text-muted hover:text-text">
        ← All campaigns
      </Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-3xl font-bold tracking-wide">{campaign.title}</h1>
            {access.isGM ? (
              <Badge tone="accent">
                <Crown className="h-3 w-3" aria-hidden /> You are the GM
              </Badge>
            ) : (
              <Badge>Player</Badge>
            )}
            {campaign.status === 'ARCHIVED' && <Badge tone="danger">Archived</Badge>}
          </div>
          {campaign.description && <p className="mt-2 max-w-2xl text-muted">{campaign.description}</p>}
        </div>
        <div className="flex gap-2">
          {campaign.settings.meetingUrl && (
            <a href={campaign.settings.meetingUrl} target="_blank" rel="noopener noreferrer">
              <Button variant="outline">
                <Video className="h-4 w-4" aria-hidden /> Join call
              </Button>
            </a>
          )}
          {live && (
            <Link to={`/campaigns/${campaign.id}/sessions/${live.id}`}>
              <Button>
                <Play className="h-4 w-4" aria-hidden /> {access.isGM ? 'Open live table' : 'Join the table'}
              </Button>
            </Link>
          )}
        </div>
      </div>

      <div role="tablist" aria-label="Campaign sections" className="scrollbar-thin mt-8 flex gap-1 overflow-x-auto border-b border-border">
        {tabs
          .filter((t) => !t.gmOnly || access.isGM)
          .map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn('-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition', tab === t.id ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text')}
            >
              <t.icon className="h-4 w-4" aria-hidden /> {t.label}
            </button>
          ))}
      </div>
      <div className="mt-6" role="tabpanel">
        {tab === 'sessions' && <SessionsTab data={data} />}
        {tab === 'characters' && <CharactersTab data={data} />}
        {tab === 'maps' && access.isGM && <MapsTab data={data} />}
        {tab === 'creatures' && access.isGM && <CreaturesTab data={data} />}
        {tab === 'members' && <MembersTab data={data} />}
        {tab === 'settings' && access.isGM && <SettingsTab data={data} />}
      </div>
    </div>
  );
}

import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { characterApi, qk, useCampaign } from '@/lib/api/hooks';
import { Button, Card } from '@/components/ui/primitives';
import { CharacterSheet } from './CharacterSheet';

export default function CharacterPage() {
  const { campaignId = '', characterId = '' } = useParams();
  const { data: campaign } = useCampaign(campaignId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isGM = !!campaign?.access.isGM;
  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <Link to={`/campaigns/${campaignId}`} className="text-sm text-muted hover:text-text">
          ← {campaign?.campaign.title ?? 'Campaign'}
        </Link>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            if (!confirm('Delete this character and their inventory? This cannot be undone.')) return;
            try {
              await characterApi.remove(campaignId, characterId);
              void qc.invalidateQueries({ queryKey: qk.characters(campaignId) });
              navigate(`/campaigns/${campaignId}`);
            } catch (e) {
              toast.error((e as Error).message);
            }
          }}
        >
          <Trash2 className="h-4 w-4" aria-hidden /> Delete
        </Button>
      </div>
      <Card className="mt-4 p-6">
        <CharacterSheet campaignId={campaignId} characterId={characterId} isGM={isGM} members={campaign?.members ?? []} />
      </Card>
    </div>
  );
}

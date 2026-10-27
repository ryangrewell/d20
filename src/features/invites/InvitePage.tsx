import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DoorOpen } from 'lucide-react';
import { campaignApi, qk } from '@/lib/api/hooks';
import { Button, Card, ErrorNotice, Spinner } from '@/components/ui/primitives';
import { Logo } from '@/components/layout/AppLayout';

export function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const preview = useQuery({ queryKey: ['invite', token], queryFn: () => campaignApi.previewInvite(token), retry: false });
  const accept = useMutation({
    mutationFn: () => campaignApi.acceptInvite(token),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.campaigns });
      navigate(`/campaigns/${r.campaignId}`, { replace: true });
    },
  });

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-atmosphere px-4">
      <Logo className="mb-8" />
      <Card className="w-full max-w-md p-8 text-center">
        {preview.isLoading && <Spinner label="Checking your invitation" />}
        {preview.error && (
          <>
            <h1 className="font-display text-xl font-semibold">Invitation unavailable</h1>
            <p className="mt-2 text-sm text-muted">{(preview.error as Error).message}</p>
            <Button className="mt-6" variant="outline" onClick={() => navigate('/dashboard')}>
              Go to dashboard
            </Button>
          </>
        )}
        {preview.data && (
          <>
            <DoorOpen className="mx-auto h-10 w-10 text-accent" aria-hidden />
            <p className="mt-4 text-sm uppercase tracking-widest text-muted">You're invited to</p>
            <h1 className="mt-2 font-display text-2xl font-bold">{preview.data.title}</h1>
            <p className="mt-2 text-sm text-muted">
              Run by {preview.data.gmName} · joining as {preview.data.role === 'SPECTATOR' ? 'a spectator' : 'a player'}
            </p>
            {preview.data.blockedReason && <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-left text-sm">{preview.data.blockedReason}</p>}
            {accept.error && (
              <div className="mt-4 text-left">
                <ErrorNotice error={accept.error} />
              </div>
            )}
            <Button size="lg" className="mt-8 w-full justify-center" loading={accept.isPending} disabled={!!preview.data.blockedReason} onClick={() => accept.mutate()}>
              {preview.data.alreadyMember ? 'Open campaign' : 'Join campaign'}
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}

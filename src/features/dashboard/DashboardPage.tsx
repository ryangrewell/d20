import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Crown, Plus, ScrollText, Swords } from 'lucide-react';
import { useCampaigns, useCreateCampaign } from '@/lib/api/hooks';
import { zodResolver } from '@/lib/forms';
import { Badge, Button, Card, EmptyState, ErrorNotice, Field, Input, Spinner, Textarea } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';

export function DashboardPage() {
  const { data, isLoading, error, refetch } = useCampaigns();
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-wide">Your campaigns</h1>
          <p className="mt-1 text-muted">Pick up where you left off, or start something new.</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" aria-hidden /> New campaign
        </Button>
      </div>

      <div className="mt-8">
        {isLoading && <Spinner label="Loading campaigns" />}
        {error && <ErrorNotice error={error} onRetry={() => void refetch()} />}
        {data && data.length === 0 && (
          <EmptyState
            icon={<ScrollText className="h-8 w-8" />}
            title="No campaigns yet"
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" aria-hidden /> Create your first campaign
              </Button>
            }
          >
            Start a campaign as GM, or ask your GM for an invite link to join theirs.
          </EmptyState>
        )}
        {data && data.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.map(({ campaign, role }) => (
              <Link key={campaign.id} to={`/campaigns/${campaign.id}`} className="group">
                <Card className="h-full p-5 transition group-hover:border-accent/60">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-display text-lg font-semibold leading-snug">{campaign.title}</h2>
                    {role === 'OWNER' ? (
                      <Badge tone="accent">
                        <Crown className="h-3 w-3" aria-hidden /> GM
                      </Badge>
                    ) : (
                      <Badge>
                        <Swords className="h-3 w-3" aria-hidden /> Player
                      </Badge>
                    )}
                  </div>
                  {campaign.description && <p className="mt-2 line-clamp-3 text-sm text-muted">{campaign.description}</p>}
                  <div className="mt-4 flex items-center gap-2 text-xs text-faint">
                    {campaign.activeSessionId && <Badge tone="success">Live now</Badge>}
                    <span>Updated {new Date(campaign.updatedAt).toLocaleDateString()}</span>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
      <CreateCampaignDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

const schema = z.object({
  title: z.string().trim().min(1, 'Give your campaign a title').max(80),
  description: z.string().max(2000),
  meetingUrl: z.union([z.literal(''), z.string().url('Enter a full link').startsWith('https://', 'Use an https:// link')]),
});

function CreateCampaignDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const create = useCreateCampaign();
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { title: '', description: '', meetingUrl: '' } });
  const onSubmit = form.handleSubmit(async (v) => {
    const c = await create.mutateAsync({ title: v.title, description: v.description, settings: v.meetingUrl ? { meetingUrl: v.meetingUrl } : {} });
    onOpenChange(false);
    form.reset();
    navigate(`/campaigns/${c.id}`);
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New campaign" description="You'll be the GM. You can change all of this later.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {create.error && <ErrorNotice error={create.error} />}
        <Field label="Title" htmlFor="title" error={form.formState.errors.title?.message}>
          <Input id="title" autoFocus placeholder="Shadows of Riverton" {...form.register('title')} />
        </Field>
        <Field label="Description" htmlFor="description" error={form.formState.errors.description?.message}>
          <Textarea id="description" placeholder="A short pitch for your players" {...form.register('description')} />
        </Field>
        <Field label="Video call link (optional)" htmlFor="meetingUrl" hint="Zoom or Teams link players can join from the table." error={form.formState.errors.meetingUrl?.message}>
          <Input id="meetingUrl" type="url" placeholder="https://zoom.us/j/…" {...form.register('meetingUrl')} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create campaign
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

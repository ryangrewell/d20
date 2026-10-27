import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import type { CampaignDashboardDto } from '@shared/dto';
import { campaignApi, qk, useCampaignMutation } from '@/lib/api/hooks';
import { zodResolver } from '@/lib/forms';
import { Button, Card, ErrorNotice, Field, Input, Textarea } from '@/components/ui/primitives';

const schema = z.object({
  title: z.string().trim().min(1, 'Required').max(80),
  description: z.string().max(2000),
  meetingUrl: z.union([z.literal(''), z.string().url('Enter a full link').startsWith('https://', 'Use an https:// link')]),
  playerWhispers: z.boolean(),
  allowSecretRolls: z.boolean(),
});

export function SettingsTab({ data }: { data: CampaignDashboardDto }) {
  const { campaign, access } = data;
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      title: campaign.title,
      description: campaign.description,
      meetingUrl: campaign.settings.meetingUrl ?? '',
      playerWhispers: campaign.settings.playerWhispers,
      allowSecretRolls: campaign.settings.allowSecretRolls,
    },
  });
  const save = useCampaignMutation(campaign.id, (v: z.output<typeof schema>) =>
    campaignApi.update(campaign.id, { title: v.title, description: v.description, settings: { meetingUrl: v.meetingUrl, playerWhispers: v.playerWhispers, allowSecretRolls: v.allowSecretRolls } }),
  [[...qk.campaigns]]);
  const archive = useCampaignMutation(campaign.id, () => campaignApi.archive(campaign.id), [[...qk.campaigns]]);
  const disabled = !access.isOwner || campaign.status !== 'ACTIVE';

  return (
    <div className="max-w-2xl space-y-6">
      <Card className="p-6">
        <form className="space-y-4" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v, { onSuccess: () => toast.success('Settings saved') }))}>
          {save.error && <ErrorNotice error={save.error} />}
          <Field label="Title" htmlFor="title" error={form.formState.errors.title?.message}>
            <Input id="title" disabled={disabled} {...form.register('title')} />
          </Field>
          <Field label="Description" htmlFor="description">
            <Textarea id="description" disabled={disabled} {...form.register('description')} />
          </Field>
          <Field label="Video call link" htmlFor="meetingUrl" hint="Zoom or Teams link shown as “Join call” at the table." error={form.formState.errors.meetingUrl?.message}>
            <Input id="meetingUrl" type="url" disabled={disabled} placeholder="https://teams.microsoft.com/…" {...form.register('meetingUrl')} />
          </Field>
          <label className="flex items-center gap-3 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" disabled={disabled} {...form.register('playerWhispers')} />
            Players may whisper each other (they can always whisper the GM)
          </label>
          <label className="flex items-center gap-3 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" disabled={disabled} {...form.register('allowSecretRolls')} />
            Players may roll secretly to the GM
          </label>
          <Button type="submit" disabled={disabled} loading={save.isPending}>
            Save settings
          </Button>
        </form>
      </Card>
      {access.isOwner && campaign.status === 'ACTIVE' && (
        <Card className="border-danger/40 p-6">
          <h2 className="font-semibold">Archive campaign</h2>
          <p className="mt-1 text-sm text-muted">Archiving keeps everything but makes the campaign read-only. Players will no longer be able to play.</p>
          <Button
            className="mt-4"
            variant="danger"
            loading={archive.isPending}
            onClick={() => confirm('Archive this campaign?') && archive.mutate(undefined, { onSuccess: () => toast.success('Campaign archived') })}
          >
            Archive campaign
          </Button>
        </Card>
      )}
    </div>
  );
}

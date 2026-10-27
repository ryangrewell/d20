import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { qk, useMe } from '@/lib/api/hooks';
import { zodResolver } from '@/lib/forms';
import { useAuth } from '@/app/auth';
import { Button, Card, ErrorNotice, Field, Input, Spinner } from '@/components/ui/primitives';

export function AccountPage() {
  const me = useMe();
  const { user } = useAuth();
  const qc = useQueryClient();
  const form = useForm({ resolver: zodResolver(z.object({ displayName: z.string().trim().min(1, 'Required').max(40) })), values: { displayName: me.data?.displayName ?? '' } });
  const save = useMutation({
    mutationFn: (displayName: string) => api('/me', { method: 'PATCH', body: { displayName } }),
    onSuccess: () => {
      toast.success('Profile updated');
      void qc.invalidateQueries({ queryKey: qk.me });
    },
  });

  if (me.isLoading) return <Spinner />;
  if (me.error) return <ErrorNotice error={me.error} />;
  return (
    <div className="max-w-xl">
      <h1 className="font-display text-3xl font-bold">Account</h1>
      <Card className="mt-6 p-6">
        <form className="space-y-4" onSubmit={form.handleSubmit((v) => save.mutate(v.displayName))} noValidate>
          <Field label="Email" htmlFor="email">
            <Input id="email" value={user?.email ?? ''} disabled readOnly />
          </Field>
          <Field label="Display name" htmlFor="displayName" hint="Shown on your cursor, tokens and chat." error={form.formState.errors.displayName?.message}>
            <Input id="displayName" {...form.register('displayName')} />
          </Field>
          {save.error && <ErrorNotice error={save.error} />}
          <Button type="submit" loading={save.isPending}>
            Save changes
          </Button>
        </form>
      </Card>
      <Card className="mt-6 p-6">
        <h2 className="font-semibold">Delete account</h2>
        <p className="mt-1 text-sm text-muted">
          To delete your account and personal data, email the site owner from your account address. Campaigns you own will be archived first so your players are not
          surprised. A self-service flow is planned.
        </p>
      </Card>
    </div>
  );
}

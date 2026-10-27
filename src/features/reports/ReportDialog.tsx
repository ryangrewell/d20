import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { Button, Field, Select, Textarea } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';

export type ReportTarget = { targetType: 'USER' | 'MESSAGE'; targetId: string; campaignId: string; label: string };

/** Sends a report to the platform admins. The reported content is captured server-side, never from the client. */
export function ReportDialog({ target, onClose }: { target: ReportTarget; onClose: () => void }) {
  const [reason, setReason] = useState('HARASSMENT');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api('/reports', { body: { targetType: target.targetType, targetId: target.targetId, campaignId: target.campaignId, reason, details } });
      toast.success('Thanks. The report was sent to the site admins.');
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Report ${target.label}`} description="Reports go to the platform administrators, not to your GM.">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Reason" htmlFor="rReason">
          <Select id="rReason" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="HARASSMENT">Harassment or abuse</option>
            <option value="INAPPROPRIATE_CONTENT">Inappropriate content</option>
            <option value="SPAM">Spam</option>
            <option value="CHEATING">Cheating or exploits</option>
            <option value="OTHER">Something else</option>
          </Select>
        </Field>
        <Field label="Details (optional)" htmlFor="rDetails">
          <Textarea id="rDetails" value={details} maxLength={2000} onChange={(e) => setDetails(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={busy}>
            Send report
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

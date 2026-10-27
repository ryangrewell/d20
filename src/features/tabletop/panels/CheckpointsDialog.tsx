import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { Button, ErrorNotice, Input, Spinner } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';
import type { SyncEngine } from '../sync';

type Checkpoint = { id: string; label: string; objectCount: number; fogOpCount: number; createdAt: string };

/** GM: save the current scene's tokens and fog, or roll the scene back to a saved point. */
export function CheckpointsDialog({ campaignId, sceneId, sceneName, engine, onClose }: { campaignId: string; sceneId: string; sceneName: string; engine: SyncEngine; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ['checkpoints', sceneId];
  const list = useQuery({ queryKey: key, queryFn: () => api<Checkpoint[]>(`/campaigns/${campaignId}/scenes/${sceneId}/checkpoints`) });
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const save = async () => {
    setBusy('save');
    try {
      await api(`/campaigns/${campaignId}/scenes/${sceneId}/checkpoints`, { body: { label } });
      setLabel('');
      void qc.invalidateQueries({ queryKey: key });
      toast.success('Checkpoint saved');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const restore = async (c: Checkpoint) => {
    if (!confirm(`Restore “${c.label}”? Tokens and fog on ${sceneName} will be replaced for everyone.`)) return;
    setBusy(c.id);
    try {
      await engine.command('restoreCheckpoint', { sceneId, checkpointId: c.id });
      toast.success(`Restored “${c.label}”`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (c: Checkpoint) => {
    await api(`/campaigns/${campaignId}/scenes/${sceneId}/checkpoints/${c.id}`, { method: 'DELETE' }).catch((e: Error) => toast.error(e.message));
    void qc.invalidateQueries({ queryKey: key });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Checkpoints · ${sceneName}`} description="Save the scene's tokens and fog now, or roll it back to an earlier save." wide>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Input aria-label="Checkpoint name" placeholder="e.g. Before the ambush" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
        <Button type="submit" loading={busy === 'save'}>
          <Save className="h-4 w-4" aria-hidden /> Save now
        </Button>
      </form>
      <div className="mt-5">
        {list.isLoading && <Spinner />}
        {list.error && <ErrorNotice error={list.error} />}
        {list.data?.length === 0 && <p className="text-sm text-faint">No checkpoints for this scene yet.</p>}
        <ul className="space-y-2">
          {list.data?.map((c) => (
            <li key={c.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{c.label}</p>
                <p className="text-xs text-faint">
                  {new Date(c.createdAt).toLocaleString()} · {c.objectCount} tokens · {c.fogOpCount} fog edits
                </p>
              </div>
              <Button size="sm" variant="secondary" loading={busy === c.id} onClick={() => void restore(c)}>
                <History className="h-4 w-4" aria-hidden /> Restore
              </Button>
              <Button size="icon" variant="ghost" aria-label={`Delete ${c.label}`} onClick={() => void remove(c)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

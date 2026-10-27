import * as RD from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export function Dialog({ open, onOpenChange, title, description, children, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: ReactNode; wide?: boolean }) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <RD.Content
          className={`fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-surface p-6 shadow-2xl ${wide ? 'max-w-2xl' : 'max-w-md'}`}
        >
          <RD.Title className="font-display text-lg font-semibold tracking-wide">{title}</RD.Title>
          {description ? <RD.Description className="mt-1 text-sm text-muted">{description}</RD.Description> : <RD.Description className="sr-only">{title}</RD.Description>}
          <div className="mt-5">{children}</div>
          <RD.Close className="absolute right-4 top-4 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-text" aria-label="Close">
            <X className="h-4 w-4" />
          </RD.Close>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

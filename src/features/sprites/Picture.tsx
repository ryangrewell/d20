import { useState } from 'react';
import { UserRound } from 'lucide-react';
import { useImageUrl } from '@/lib/api/images';
import { cn } from '@/components/ui/primitives';

/** A character's or creature's picture; small pixel sprites stay crisp, photos are smoothed. */
export function Picture({ campaignId, assetId, className, alt = '' }: { campaignId: string; assetId: string | undefined; className?: string; alt?: string }) {
  const url = useImageUrl(campaignId, assetId);
  const [pixel, setPixel] = useState(true);
  return (
    <div className={cn('grid place-items-center overflow-hidden rounded-lg border border-border bg-surface-2', className)}>
      {url.data ? (
        <img
          src={url.data}
          alt={alt}
          className="h-full w-full object-contain"
          style={{ imageRendering: pixel ? 'pixelated' : 'auto' }}
          onLoad={(e) => setPixel(e.currentTarget.naturalWidth <= 128)}
        />
      ) : (
        <UserRound className="h-1/2 w-1/2 text-faint" aria-hidden />
      )}
    </div>
  );
}

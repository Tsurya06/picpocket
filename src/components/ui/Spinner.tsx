import { Loader2 } from 'lucide-react';

export function Spinner({ size = 18, className = '' }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={`animate-spin ${className}`} aria-hidden="true" />;
}

const SKELETON_RATIOS = [
  '4 / 3',
  '1 / 1',
  '3 / 4',
  '4 / 5',
  '16 / 10',
  '2 / 3',
  '4 / 3',
  '1 / 1',
  '3 / 4',
  '5 / 4',
  '4 / 3',
  '1 / 1',
];

export function SkeletonGrid({ count = 12 }: { count?: number }) {
  return (
    <div className="masonry" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="shimmer overflow-hidden rounded-[var(--radius-tile)]"
          style={{ aspectRatio: SKELETON_RATIOS[index % SKELETON_RATIOS.length] }}
        />
      ))}
    </div>
  );
}

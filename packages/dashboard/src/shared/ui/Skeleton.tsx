interface SkeletonProps {
  rows?: number;
  label?: string;
}

/**
 * What a table looks like while it is being read.
 *
 * Rows at the height the real ones will have, rather than a spinner: the
 * page does not jump when the answer lands, and the shape on screen is
 * already the shape of the answer. Under `prefers-reduced-motion` the sweep
 * stops and the bars simply sit there, which is still the right shape.
 */
export function Skeleton({ rows = 3, label }: SkeletonProps) {
  return (
    <div className="skeleton" role="status" aria-label={label ?? 'reading'}>
      {Array.from({ length: rows }, (_, index) => (
        // Bars are positions in a placeholder; nothing here has an identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
        <div key={index} className="skeleton-row">
          <span className="skeleton-bar" style={{ width: `${68 - index * 9}%` }} />
        </div>
      ))}
    </div>
  );
}

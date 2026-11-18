import { openInEditor, type RouteStats } from '../../../api/index';
import { count, duration } from '../../../shared/format';
import { badgeFor } from '../../../shared/waterfall/badge';

interface TopFindingProps {
  row: RouteStats;
}

/**
 * What is already known about this route, and the way to the line of code.
 *
 * The charts say when it was slow; this says whether a detector already
 * explained why. Its own block rather than a column, because a hint and a
 * call site need room to be read.
 */

export function TopFinding({ row }: TopFindingProps) {
  const found = row.findings[0];
  if (!found) return null;

  const site = found.callsite;
  const openSite = () => {
    if (site) openInEditor(site.file, site.line);
  };

  return (
    <div className="route-top-finding">
      <div className="route-finding-head">
        <span className="badge-nplus">{badgeFor(found.detector)}</span>
        <span className="s-fg">{found.title}</span>
        <span className="s-dim">
          · on {count(found.calls)} call{found.calls === 1 ? '' : 's'}
          {found.recoverableMs > 0 ? ` · ${duration(found.recoverableMs)} recoverable` : ''}
        </span>
      </div>
      <div className="route-finding-hint s-fg2">
        {found.callsite ? (
          <>
            <button
              type="button"
              className="fix-site"
              title={`open ${found.callsite.relative}:${found.callsite.line} in the editor`}
              onClick={openSite}
            >
              {found.callsite.relative}:{found.callsite.line}
            </button>{' '}
            → {found.hint}
          </>
        ) : (
          found.hint
        )}
      </div>
    </div>
  );
}

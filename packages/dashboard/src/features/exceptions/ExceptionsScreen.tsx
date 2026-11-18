import { useEffect, useState } from 'react';
import { fetchExceptions } from '../../api/index';
import { count } from '../../shared/format';
import { Skeleton } from '../../shared/ui/Skeleton';
import { useLiveQuery } from '../../shared/useLiveQuery';
import { Group } from './parts/Group';

interface ExceptionsScreenProps {
  blameEnabled: boolean;
  onOpenRequest: (id: string) => void;
}

export function ExceptionsScreen({ blameEnabled, onOpenRequest }: ExceptionsScreenProps) {
  const { data: groups, error } = useLiveQuery(fetchExceptions);
  const [open, setOpen] = useState<Set<string>>(new Set());

  // The first group is expanded by default — usually the one that matters.
  useEffect(() => {
    const first = groups?.[0];
    if (first) setOpen(new Set([first.id]));
  }, [groups]);

  const toggleGroup = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (error) return <div className="empty s-err mono">{error}</div>;
  if (!groups) return <Skeleton rows={3} label="reading the exceptions" />;

  if (groups.length === 0) {
    return (
      <div className="empty">
        <div className="empty-card">
          <div className="empty-body">
            <h1 className="empty-title">No exceptions recorded</h1>
            <p className="empty-text">
              Nothing in the buffer has thrown. Exceptions are grouped by normalized stack, so a
              repeating error shows up as one row with a count.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const occurrences = groups.reduce((sum, group) => sum + group.count, 0);

  return (
    <div className="exceptions">
      <header className="exceptions-head">
        <span>
          {count(groups.length)} groups · {count(occurrences)} occurrences
        </span>
        <span className="spacer" />
        <span>grouped by normalized stack</span>
      </header>

      <div className="exceptions-body">
        {groups.map((group) => (
          <Group
            key={group.id}
            group={group}
            open={open.has(group.id)}
            onToggle={() => toggleGroup(group.id)}
            blameEnabled={blameEnabled}
            onOpenRequest={onOpenRequest}
          />
        ))}
      </div>
    </div>
  );
}

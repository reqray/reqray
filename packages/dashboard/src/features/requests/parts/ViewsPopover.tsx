import { useState } from 'react';
import type { SavedView } from '../../../shared/list/views';

interface ViewsPopoverProps {
  views: readonly SavedView[];
  open: boolean;
  /** There is a filter worth saving — something is narrowed. */
  canSave: boolean;
  onToggleOpen: () => void;
  onApply: (view: SavedView) => void;
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
}

/**
 * The `views` pill: saved filters, applied in one click.
 *
 * A view is the whole question — tokens, chips, route — under a name. The
 * popover lists them, applies on click, and saves the current filter under a
 * typed name; saving under an existing name updates it.
 */
export function ViewsPopover({
  views,
  open,
  canSave,
  onToggleOpen,
  onApply,
  onSave,
  onDelete,
}: ViewsPopoverProps) {
  const [name, setName] = useState('');

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    onSave(name);
    setName('');
  };

  return (
    <div className="views">
      <button
        type="button"
        className="chip"
        aria-pressed={views.length > 0}
        aria-expanded={open}
        onClick={onToggleOpen}
      >
        views{views.length > 0 ? ` · ${views.length}` : ''}
      </button>

      {open ? (
        <div className="views-pop">
          <div className="views-head label">SAVED VIEWS</div>

          {views.length === 0 ? (
            <div className="views-empty s-dim mono">
              nothing saved yet — narrow the list, then keep the question under a name
            </div>
          ) : (
            views.map((view) => (
              <div key={view.name} className="views-row">
                <button
                  type="button"
                  className="views-apply mono"
                  title={view.query || 'chips only'}
                  onClick={() => onApply(view)}
                >
                  {view.name}
                </button>
                <button
                  type="button"
                  className="views-delete"
                  title={`forget "${view.name}"`}
                  onClick={() => onDelete(view.name)}
                >
                  ✕
                </button>
              </div>
            ))
          )}

          <form className="views-save" onSubmit={save}>
            <input
              value={name}
              placeholder={canSave ? 'save current as…' : 'nothing to save — filter first'}
              disabled={!canSave}
              onChange={(event) => setName(event.target.value)}
            />
            <button type="submit" className="btn-secondary" disabled={!canSave || !name.trim()}>
              save
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { apiUrl, fetchRequest } from '../api';

/**
 * The export menu.
 *
 * Two of the four items are files the collector builds — it has the bodies and
 * headers, the panel only has rows — and two are clipboard writes the panel
 * can do itself. A download that the environment blocks falls back to the
 * clipboard rather than failing silently.
 */
export function ExportMenu({
  selected,
  onToast,
}: {
  /** The request the trace export applies to, if one is open or highlighted. */
  selected: string | null;
  onToast: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const download = (path: string, what: string) => {
    // A plain navigation: the response carries content-disposition, so the
    // browser saves it and the page stays where it is.
    window.location.href = apiUrl(path);
    onToast(`${what} downloading…`);
    setOpen(false);
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast(`${what} copied to the clipboard`);
    } catch {
      onToast(`${what} could not be copied — the browser refused clipboard access`);
    }
    setOpen(false);
  };

  return (
    <div className="export" ref={box}>
      <button
        type="button"
        className="btn-secondary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        export ▾
      </button>

      {open ? (
        <div className="export-menu">
          <button
            type="button"
            className="export-item"
            onClick={() => download('/export/har', 'HAR')}
          >
            <span>HAR · filtered</span>
            <span className="s-dim">everything the buffer holds, masked as stored</span>
          </button>
          <button
            type="button"
            className="export-item"
            onClick={() => download('/export/curl', 'cURL set')}
          >
            <span>cURL set · filtered</span>
            <span className="s-dim">one command per request, as a .sh</span>
          </button>
          <button
            type="button"
            className="export-item"
            disabled={!selected}
            onClick={() => {
              if (!selected) return;
              void fetchRequest(selected)
                .then((detail) => copy(JSON.stringify(detail.spans, null, 2), 'Trace JSON'))
                .catch(() => onToast('that request is no longer in the buffer'));
            }}
          >
            <span>Trace JSON · selected</span>
            <span className="s-dim">
              {selected ? `spans of #${selected}` : 'no request selected'}
            </span>
          </button>
          <button
            type="button"
            className="export-item"
            onClick={() => void copy(window.location.href, 'Deep link')}
          >
            <span>Deep link · current view</span>
            <span className="s-dim">{window.location.hash || '#l/requests'}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

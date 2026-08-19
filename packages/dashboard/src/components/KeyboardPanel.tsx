/** The `?` panel — the only place the shortcuts are written down. */

const SHORTCUTS: Array<[key: string, what: string]> = [
  ['j / k', 'move the selection down / up'],
  ['↵', 'open the selected request'],
  ['esc', 'close the topmost overlay, or go back to the list'],
  ['/', 'focus the filter field'],
  ['space', 'pause or resume the live feed'],
  ['p', 'pin the selected request so the ring buffer keeps it'],
  ['c', 'add the selected request to the comparison'],
  ['?', 'this panel'],
];

export function KeyboardPanel({ onClose }: { onClose: () => void }) {
  return (
    <>
      <button type="button" className="scrim" aria-label="close" onClick={onClose} />
      <div className="keys-panel" role="dialog" aria-label="Keyboard shortcuts">
        <div className="keys-head">
          <span className="drawer-title">Keyboard</span>
          <span className="spacer" />
          <button type="button" className="drawer-close" onClick={onClose}>
            esc ✕
          </button>
        </div>
        <div className="keys-body">
          {SHORTCUTS.map(([key, what]) => (
            <div key={key} className="keys-row">
              <span className="keys-key">{key}</span>
              <span className="s-fg2">{what}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

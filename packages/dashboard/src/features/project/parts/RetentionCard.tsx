import { useState } from 'react';
import type { ProjectReport } from '../../../api/index';
import { saveRetention } from '../../../api/index';
import { ago, count, bytes as formatBytes } from '../../../shared/format';

interface RetentionCardProps {
  report: ProjectReport;
  onChanged: (days: number | null) => void;
}

/**
 * How long anything is kept — the one setting this panel changes rather than
 * reports.
 *
 * Lowering it deletes data, so the button says what will happen and the
 * server checks the number again on arrival. When the application handed the
 * panel no policy, the card says what to pass instead of showing a control
 * that cannot work.
 */
export function RetentionCard({ report, onChanged }: RetentionCardProps) {
  const { retention, storage, log } = report;
  const [days, setDays] = useState(() => (retention?.days == null ? '' : String(retention.days)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const apply = () => {
    const trimmed = days.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next !== null && (!Number.isFinite(next) || next <= 0)) {
      setError('a number of days, or empty for no limit');
      return;
    }

    setSaving(true);
    setError(null);
    saveRetention({ days: next })
      .then((limits) => {
        setDays(limits.days === null ? '' : String(limits.days));
        setSaved(true);
        onChanged(limits.days);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSaving(false));
  };

  const edit = (event: React.ChangeEvent<HTMLInputElement>) => {
    setDays(event.target.value);
    setSaved(false);
  };

  const applyOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') apply();
  };

  return (
    <section className="panel-card">
      <div className="label">RETENTION</div>

      {retention ? (
        <>
          <div className="retention-row">
            <label className="retention-field" htmlFor="retention-days">
              <span className="s-dim">keep for</span>
              <input
                id="retention-days"
                className="retention-input"
                inputMode="numeric"
                value={days}
                placeholder="no limit"
                disabled={!retention.writable || saving}
                onChange={edit}
                onKeyDown={applyOnEnter}
              />
              <span className="s-dim">days</span>
            </label>
            {retention.writable ? (
              <button type="button" className="btn-secondary" onClick={apply} disabled={saving}>
                {saving ? 'applying…' : 'apply'}
              </button>
            ) : (
              <span className="s-dim mono">read-only</span>
            )}
          </div>

          {error ? <p className="s-err mono retention-note">{error}</p> : null}
          {saved && !error ? (
            <p className="s-dim mono retention-note">
              applied — anything older has already been swept
            </p>
          ) : null}
          <p className="s-dim mono retention-note">
            {retention.remembered
              ? 'remembered on disk: it survives a restart'
              : 'this process only — pass a file to retentionPolicy to keep it'}
            {retention.maxRequests !== null ? ` · at most ${count(retention.maxRequests)}` : ''}
            {retention.maxBytes !== null ? ` · at most ${formatBytes(retention.maxBytes)}` : ''}
          </p>
        </>
      ) : (
        <p className="s-dim mono retention-note">
          the stores keep to their own limits. Pass one policy to change that:
          <br />
          <span className="mono">
            reqray(&#123; retention: retentionPolicy(&#123; days: 7 &#125;) &#125;)
          </span>
        </p>
      )}

      <div className="retention-facts">
        <div>
          <span className="s-dim">store</span>{' '}
          {storage ? (
            <>
              {count(storage.size)}
              {storage.bytes !== null ? ` · ${formatBytes(storage.bytes)}` : ''}
              {storage.oldestAt ? (
                <span className="s-fg2"> · oldest {ago(storage.oldestAt)}</span>
              ) : null}
            </>
          ) : (
            <span className="s-dim">—</span>
          )}
        </div>
        <div>
          <span className="s-dim">log</span>{' '}
          {log ? (
            <>
              {log.files} {log.files === 1 ? 'file' : 'files'} · {formatBytes(log.bytes)}
              {log.oldestAt ? <span className="s-fg2"> · from {ago(log.oldestAt)}</span> : null}
              {log.dropped > 0 ? (
                <span className="s-warn"> · {count(log.dropped)} lines dropped</span>
              ) : null}
              {log.writing ? null : <span className="s-err"> · stopped</span>}
            </>
          ) : (
            <span className="s-dim">not written</span>
          )}
        </div>
        {log ? <div className="s-dim mono retention-path">{log.dir}</div> : null}
      </div>
    </section>
  );
}

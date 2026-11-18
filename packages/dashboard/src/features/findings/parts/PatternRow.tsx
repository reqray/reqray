import type { FindingPattern, StoredPatternState } from '../../../api/index';
import { ago, clock, count, duration } from '../../../shared/format';
import { badgeFor } from '../../../shared/waterfall/badge';
import { gradeOf, LOUD_MS, stateWord, toIssue, toMarkdown } from '../lib/wording';

interface PatternRowProps {
  pattern: FindingPattern;
  expanded: boolean;
  /** The costliest pattern on screen — every bar is a share of it. */
  loudest: number;
  onToggle: () => void;
  onState: (state: StoredPatternState) => void;
  onOpenSite: () => void;
  onCopy: (label: string, text: string) => void;
  onOpenRequest: (id: string) => void;
}

/** One pattern: the line, and what it has to say when opened. */
export function PatternRow({
  pattern,
  expanded,
  loudest,
  onToggle,
  onState,
  onOpenSite,
  onCopy,
  onOpenRequest,
}: PatternRowProps) {
  const width = Math.max(2, Math.round((pattern.recoverableMs / loudest) * 100));

  return (
    <div className="findings-row" data-state={pattern.state}>
      <button
        type="button"
        className="findings-grid findings-line"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="findings-gutter" data-grade={gradeOf(pattern)} />
        <span>
          <span className="badge-nplus">{badgeFor(pattern.detector)}</span>
        </span>
        <span className="ellipsis">{pattern.title}</span>
        {/* Accent only when it is a door: a location opens the
                editor, a route fallback is just an address. */}
        <span className={pattern.callsite ? 'ellipsis s-acc' : 'ellipsis s-dim'}>
          {pattern.callsite
            ? `${pattern.callsite.relative}:${pattern.callsite.line}`
            : (pattern.routes[0]?.route ?? '—')}
        </span>
        <span className="s-fg2">
          {pattern.routes.length} route{pattern.routes.length === 1 ? '' : 's'}
        </span>
        <span className="s-fg2">
          {count(pattern.occurrences)}× · {ago(pattern.lastSeen)}
        </span>
        <span className="findings-cost">
          <span className="findings-bar">
            <span
              style={{
                width: `${width}%`,
              }}
            />
          </span>
          <span className={pattern.recoverableMs >= LOUD_MS ? 's-err' : 's-warn'}>
            {pattern.recoverableMs > 0 ? duration(pattern.recoverableMs) : '—'}
          </span>
        </span>
        <span className="findings-state" data-state={pattern.state}>
          {stateWord(pattern.state)}
        </span>
      </button>

      {expanded ? (
        <div className="findings-open">
          <p className="findings-hint s-fg2">{pattern.hint}</p>

          <div className="findings-routes s-dim">
            {pattern.routes.map((route) => (
              <span key={`${route.method} ${route.route}`}>
                {route.method} {route.route} · {count(route.calls)}
              </span>
            ))}
          </div>

          {pattern.examples.length > 0 ? (
            <div className="findings-examples">
              <div className="label">WORST EXAMPLES</div>
              {pattern.examples.map((example) => (
                <button
                  key={example.requestId}
                  type="button"
                  className="peek-row"
                  onClick={() => onOpenRequest(example.requestId)}
                >
                  <span className="s-dim">{clock(example.startedAt)}</span>
                  <span className="s-fg2">{example.method}</span>
                  <span className="ellipsis">{example.route}</span>
                  <span className="s-fg2">{example.status}</span>
                  <span className="s-warn">
                    {duration(example.durationMs)}
                    {example.costMs > 0 ? ` · ${duration(example.costMs)} lost` : ''}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="findings-actions">
            {pattern.callsite ? (
              <button type="button" className="btn-secondary" onClick={onOpenSite}>
                open in editor ↗
              </button>
            ) : null}
            {pattern.state === 'new' || pattern.state === 'fixed' ? (
              <button type="button" className="btn-secondary" onClick={() => onState('ack')}>
                acknowledge
              </button>
            ) : (
              <button type="button" className="btn-secondary" onClick={() => onState('new')}>
                reopen
              </button>
            )}
            {pattern.state === 'muted' ? (
              <button type="button" className="btn-secondary" onClick={() => onState('new')}>
                unmute
              </button>
            ) : (
              <button
                type="button"
                className="btn-secondary"
                title="hide this pattern and stop it flagging rows; the detector keeps running"
                onClick={() => onState('muted')}
              >
                mute this pattern
              </button>
            )}
            <span className="spacer" />
            <button
              type="button"
              className="btn-secondary"
              onClick={() => onCopy('markdown', toMarkdown(pattern))}
            >
              copy markdown
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => onCopy('JSON', JSON.stringify(pattern, null, 2))}
            >
              copy json
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => onCopy('issue body', toIssue(pattern))}
            >
              copy github issue
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

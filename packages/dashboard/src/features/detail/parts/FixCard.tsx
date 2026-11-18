import { useState } from 'react';
import {
  type Finding,
  openInEditor,
  type RequestDetail,
  saveFindingState,
} from '../../../api/index';
import { count, oneLine } from '../../../shared/format';
import { useFlash } from '../../../shared/ui/useFlash';
import { badgeFor } from '../../../shared/waterfall/badge';
import { costLine, evidenceLine } from '../lib/briefing';
import { buildFixPrompt, suggestedFix } from '../lib/fix';
import { HotFrames } from './HotFrames';

/** The pattern key a finding's state is filed under — the same rule as the server's. */
export function patternKeyOf(detail: RequestDetail, finding: Finding): string {
  return finding.callsite
    ? `${finding.detector}@${finding.callsite.relative}:${finding.callsite.line}`
    : `${finding.detector}@${detail.method} ${detail.route}`;
}

interface FixCardProps {
  detail: RequestDetail;
  finding: Finding;
  replayEnabled: boolean;
  /** Opens the SQL tab on the statement behind the finding. */
  onShowCalls: (fingerprint: string) => void;
  onReplay: () => void;
}

/**
 * THE FIX: the costliest finding, answered rather than reported.
 *
 * Four elements, per the detector contract — what, where, what it costs,
 * how to fix it — plus the ways out: the editor, a prompt for an assistant,
 * the calls themselves, and the mute that files it away. The diff appears
 * only when a template is confident; a wrong fix is worse than none.
 */
export function FixCard({ detail, finding, replayEnabled, onShowCalls, onReplay }: FixCardProps) {
  const [prompted, flashPrompted] = useFlash();
  const [muted, setMuted] = useState(false);
  const diff = suggestedFix(finding);
  // A const binding, so the `in` narrowing survives into the callbacks.
  const evidence = finding.evidence;
  const repeats = 'repeats' in evidence ? evidence.repeats : 0;

  const site = finding.callsite;
  const openSite = () => {
    if (site) openInEditor(site.file, site.line);
  };

  /** Filing the pattern away; a refusal puts the button back. */
  const mute = () => {
    setMuted(true);
    void saveFindingState(patternKeyOf(detail, finding), 'muted').catch(() => setMuted(false));
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildFixPrompt(detail, finding));
      flashPrompted();
    } catch {
      // Clipboard denied — nothing to break.
    }
  };

  return (
    <section className="callout fix-card" data-severity={finding.severity}>
      <div className="callout-head">
        <span className="badge-nplus" data-severity={finding.severity}>
          {badgeFor(finding.detector)}
        </span>
        <span className="callout-title">{finding.title}</span>
        <span className="spacer" />
        <span className="mono s-warn" style={{ fontSize: 11 }}>
          {/* Not every finding costs milliseconds this request gets
              back — see `costLine`. */}
          {costLine(finding, detail.durationMs)}
        </span>
      </div>
      <div className="callout-sql ellipsis">{oneLine(evidenceLine(finding))}</div>
      {evidence.kind === 'slow_code' ? (
        <HotFrames frames={evidence.frames} busyShare={evidence.busyShare} />
      ) : null}
      <div className="callout-hint">
        {finding.callsite ? (
          <>
            called from{' '}
            <button type="button" className="fix-site" onClick={openSite}>
              {finding.callsite.relative}:{finding.callsite.line}
            </button>{' '}
            → {finding.hint}
          </>
        ) : (
          finding.hint
        )}
      </div>

      <div className="fix-actions">
        {finding.callsite ? (
          <button type="button" className="btn-secondary fix-open" onClick={openSite}>
            open in editor ↗
          </button>
        ) : null}
        <button type="button" className="btn-secondary" onClick={() => void copyPrompt()}>
          {prompted ? 'copied ✓' : 'copy fix prompt'}
        </button>
        {'fingerprint' in evidence && repeats > 0 ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onShowCalls(evidence.fingerprint)}
          >
            show the {count(repeats)} calls
          </button>
        ) : null}
        <button
          type="button"
          className="btn-secondary"
          title="hide this pattern from the list and the findings tab; the detector keeps running"
          disabled={muted}
          onClick={mute}
        >
          {muted ? 'muted ✓' : 'mute this pattern'}
        </button>
      </div>

      {diff ? (
        <div className="fix-diff mono">
          <div className="fix-diff-head label">
            SUGGESTED FIX
            {finding.callsite ? (
              <span className="s-dim" style={{ textTransform: 'none' }}>
                {' '}
                · {finding.callsite.relative}:{finding.callsite.line}
              </span>
            ) : null}
            <span className="spacer" />
            <span className="s-ok" style={{ textTransform: 'none' }}>
              1 query instead of {count(repeats)}
            </span>
          </div>
          {diff.removed.map((line) => (
            <div key={line} className="fix-line fix-del">
              <span className="fix-sign">−</span>
              {line}
            </div>
          ))}
          {diff.added.map((line) => (
            <div key={line} className="fix-line fix-add">
              <span className="fix-sign">+</span>
              {line}
            </div>
          ))}
          <div className="fix-diff-foot">
            <span className="s-dim">{diff.note}</span>
            <span className="spacer" />
            {replayEnabled ? (
              <button
                type="button"
                className="btn-accent"
                title="re-run this request and compare it against this recording"
                onClick={onReplay}
              >
                replay & verify
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

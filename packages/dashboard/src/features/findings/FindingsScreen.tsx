import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type DetectorSetting,
  type FindingPattern,
  type FindingsResponse,
  fetchFindings,
  openInEditor,
  type StoredPatternState,
  saveFindingState,
} from '../../api/index';
import { useLive, useToast } from '../../app/PanelContext';
import { isOpen, unreadCount } from '../../shared/findings';
import { clock, count, detectorOptions, duration } from '../../shared/format';
import { Skeleton } from '../../shared/ui/Skeleton';
import { useLiveQuery } from '../../shared/useLiveQuery';
import { PatternRow } from './parts/PatternRow';

/**
 * The work list: every recorded occurrence, grouped into patterns.
 *
 * The request list answers "what ran"; this screen answers "what is worth
 * fixing". Grouping is by detector and code location, so eight hundred
 * occurrences collapse into the handful of problems they actually are, and
 * the order is by recoverable time — never by recency, which is the list's
 * question, already answered elsewhere.
 */

/** The store cannot read findings back — a refusal, not an absence. */
const unavailable = 'unavailable' as const;

/** The patterns on screen: everything, or only what is still open. */
function shownPatterns(
  report: FindingsResponse | null,
  openOnly: boolean,
): readonly FindingPattern[] {
  if (report === null) return [];
  if (!openOnly) return report.patterns;
  return report.patterns.filter(isOpen);
}

/**
 * Why the list is empty.
 *
 * "Nothing open" and "nothing found" are different answers, and a reader who
 * filtered to the open ones needs to know which one they are looking at.
 */
function emptyReason(hiddenByFilter: boolean, windowed: boolean): string {
  if (hiddenByFilter) return 'nothing open — every pattern here is muted or looks fixed';
  return windowed ? 'no findings in this window' : 'no findings recorded';
}

interface FindingsScreenProps {
  /** A stretch of the list's window, when the status bar sent the reader here. */
  range: readonly [number, number] | null;
  /** What was looking — an empty list must say so, or it claims clean code. */
  detectors: readonly DetectorSetting[];
  onClearRange: () => void;
  onOpenRequest: (id: string) => void;
  /** How many patterns are `new` — the tab's dot follows it. */
  onNewCount: (newPatterns: number) => void;
}

export function FindingsScreen({
  range,
  detectors,
  onClearRange,
  onOpenRequest,
  onNewCount,
}: FindingsScreenProps) {
  const live = useLive();
  const onToast = useToast();
  const [openOnly, setOpenOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const reportNew = useRef(onNewCount);
  reportNew.current = onNewCount;

  // `keepStale`: the last answer stays up while the next window's is read —
  // the range chips would otherwise blink a skeleton between two reports. A
  // store that answers `null` cannot read findings back at all.
  const query = useLiveQuery(
    useCallback(
      async (signal: AbortSignal) => (await fetchFindings(range, signal)) ?? unavailable,
      [range],
    ),
    { live, keepLastGood: true, keepStale: true },
  );
  // A failed first read shows as the same refusal it always has.
  const answer = query.data ?? (query.error ? unavailable : null);

  useEffect(() => {
    if (typeof answer === 'object' && answer) reportNew.current(unreadCount(answer.patterns));
  }, [answer]);

  const setState = useCallback(
    (id: string, state: StoredPatternState) => {
      saveFindingState(id, state)
        .catch(() => undefined)
        .then(query.reload);
    },
    [query.reload],
  );

  const copy = useCallback(
    (label: string, text: string) => {
      navigator.clipboard
        .writeText(text)
        .then(() => onToast(`${label} copied — paste it anywhere`))
        .catch(() => onToast('the clipboard refused — is the panel focused?'));
    },
    [onToast],
  );

  const toggleExpanded = (id: string) => setExpanded((current) => (current === id ? null : id));

  /** The line of code behind a pattern, in the reader's own editor. */
  const openSite = (pattern: FindingPattern) => {
    const site = pattern.callsite;
    if (!site) return;
    openInEditor(site.file, site.line);
    onToast(`opening ${site.relative}:${site.line} in the editor`);
  };

  const report = typeof answer === 'object' && answer !== null ? answer : null;
  const patterns = shownPatterns(report, openOnly);
  const loudest = Math.max(...patterns.map((item) => item.recoverableMs), 1);

  /**
   * The patterns, or the reason there are none to show.
   *
   * A store that cannot read them back, a report still on its way, and a
   * report that found nothing are three different answers, and only the
   * last one is good news.
   */
  const patternList = () => {
    if (answer === 'unavailable') {
      return (
        <p className="findings-empty s-dim mono">
          this store cannot read its findings back — the tab would be a claim about code it never
          saw
        </p>
      );
    }

    if (report === null) {
      return <Skeleton rows={4} label="reading the findings" />;
    }

    if (patterns.length === 0) {
      return (
        <div className="findings-empty mono">
          <p className="s-fg2">
            {emptyReason(openOnly && report.patterns.length > 0, range !== null)}
          </p>
          {/* What was looking. Silence from a disabled detector is not a
              clean bill of health, so the empty state names them all. */}
          <div className="findings-watchers s-dim">
            {detectors.map((detector) => (
              <span key={detector.id}>
                {detector.enabled ? '✔' : '✘'} {detector.id}
                {` · ${detectorOptions(detector.options)}`}
              </span>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="findings-table mono">
        <div className="findings-grid findings-cols label">
          <span />
          <span>TYPE</span>
          <span>WHAT</span>
          <span>WHERE</span>
          <span>ROUTES</span>
          <span>SEEN</span>
          <span>RECOVERABLE</span>
          <span>STATE</span>
        </div>

        {patterns.map((pattern) => (
          <PatternRow
            key={pattern.id}
            pattern={pattern}
            expanded={expanded === pattern.id}
            loudest={loudest}
            onToggle={() => toggleExpanded(pattern.id)}
            onState={(next) => setState(pattern.id, next)}
            onOpenSite={() => openSite(pattern)}
            onCopy={copy}
            onOpenRequest={onOpenRequest}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="findings-screen">
      <div className="findings-head">
        <span className="label">FINDINGS</span>
        {report ? (
          <>
            <span className="mono s-fg2">
              {count(report.patterns.length)} pattern{report.patterns.length === 1 ? '' : 's'} ·{' '}
              {count(report.occurrences)} occurrence{report.occurrences === 1 ? '' : 's'}
            </span>
            {report.recoverableMs > 0 ? (
              <span className="mono s-warn">{duration(report.recoverableMs)} recoverable</span>
            ) : null}
          </>
        ) : null}

        {range ? (
          <button
            type="button"
            className="route-filter"
            title="the whole store instead"
            onClick={onClearRange}
          >
            window: {clock(range[0])} → {clock(range[1])} ✕
          </button>
        ) : null}

        <span className="spacer" />

        <button
          type="button"
          className="chip"
          aria-pressed={openOnly}
          title="hide muted patterns and the ones that look fixed"
          onClick={() => setOpenOnly((current) => !current)}
        >
          open only
        </button>
      </div>

      {report?.truncated ? (
        <p className="findings-note s-warn mono">
          the store stopped reading before the window ended — these patterns are drawn from its most
          recent requests, not all of them
        </p>
      ) : null}

      {patternList()}
    </div>
  );
}

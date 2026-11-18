import type { ProjectReport } from '../../../api/index';

interface InstrumentationProps {
  report: ProjectReport;
}

/**
 * What was instrumented, and what was not.
 *
 * The most useful thing on the screen: it is the answer to "why do I not see
 * my SQL", which used to exist only in a startup line that has long scrolled
 * away — or, in a container, was never on screen at all.
 */
export function Instrumentation({ report }: InstrumentationProps) {
  if (report.instrumentation.length === 0) {
    return (
      <p className="s-warn mono">
        nothing was instrumented — start with <code>node --import @reqray/register</code>
      </p>
    );
  }

  return (
    <div className="instr">
      {report.instrumentation.map((entry) => (
        <div key={entry.name} className="instr-row" data-ok={entry.ok}>
          <span className={entry.ok ? 's-ok' : 's-err'}>{entry.ok ? '✔' : '✘'}</span>
          <span className="mono">
            {entry.name}
            {entry.builtin ? ' (built-in)' : entry.version ? `@${entry.version}` : ''}
          </span>
          <span className={`mono ${entry.ok ? 's-fg2' : 's-warn'}`}>
            {entry.ok ? entry.captures : (entry.reason ?? entry.captures)}
          </span>
          {entry.hint ? <span className="instr-hint mono">→ {entry.hint}</span> : null}
        </div>
      ))}
    </div>
  );
}

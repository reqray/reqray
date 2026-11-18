import type { ExplainResult } from '../../../api/index';
import { duration, durationTone, oneLine } from '../../../shared/format';
import { highlightSql } from '../lib/sqlHighlight';
import type { PlanState, QueryGroup } from '../tabs/SqlTab';

/**
 * What a row of the SQL tab says about itself, beside its duration.
 *
 * A group says how many calls it stands for; a single query says how many
 * rows it brought back, or nothing when the driver did not count them.
 */
function noteOf(query: QueryGroup): string {
  if (query.calls > 1) return `${query.calls} calls`;
  if (query.rowCount === null) return '';
  return `${query.rowCount} rows`;
}

/** The plan tree as indented text — the shape everyone knows from psql. */
function planText(result: ExplainResult): string {
  return result.nodes
    .map((node) => {
      const stats = [
        node.rows !== null ? `rows≈${node.rows}` : null,
        node.cost !== null ? `cost=${node.cost}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      return `${'  '.repeat(node.depth)}${node.depth > 0 ? '→ ' : ''}${node.label}${stats ? `  (${stats})` : ''}`;
    })
    .join('\n');
}

interface QueryRowProps {
  query: QueryGroup;
  open: boolean;
  /** The plan for this statement, once one has been asked for. */
  plan: PlanState | undefined;
  onToggle: () => void;
  onExplain: () => void;
}

/** One statement: the line, and everything it has to say when opened. */
export function QueryRow({ query, open, plan, onToggle, onExplain }: QueryRowProps) {
  return (
    <div id={`sql-${query.id}`}>
      <button type="button" className="sql-row" onClick={onToggle}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="ellipsis s-fg2">{oneLine(query.sql)}</span>
        <span className={`cell-right ${durationTone(query.durationMs)}`}>
          {duration(query.durationMs)}
        </span>
        <span className="sql-note">{noteOf(query)}</span>
      </button>
      {open ? (
        <div className="sql-open">
          <div className="sql-block">{highlightSql(query.sql)}</div>
          {query.values && query.values.length > 0 ? (
            <div className="sql-origin mono">
              {query.values.map((value, index) => `$${index + 1} = ${value}`).join(' · ')}
              {query.calls > 1 ? '  (values of the first call)' : ''}
            </div>
          ) : null}
          {query.callsite ? (
            <div className="sql-origin">
              {query.callsite.relative}:{query.callsite.line}
            </div>
          ) : null}
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn-secondary"
              disabled={plan?.status === 'loading'}
              onClick={onExplain}
            >
              {plan?.status === 'loading' ? 'planning…' : 'EXPLAIN'}
            </button>
          </div>
          {plan?.status === 'error' ? (
            <p className="s-warn mono" style={{ marginTop: 6 }}>
              {plan.message}
            </p>
          ) : null}
          {plan?.status === 'done' ? (
            <div style={{ marginTop: 6 }}>
              {plan.result.notes.map((note) => (
                <p
                  key={note.message}
                  className={`mono ${note.severity === 'warn' ? 's-warn' : 's-fg2'}`}
                  style={{ margin: '4px 0', fontSize: 12 }}
                >
                  {note.severity === 'warn' ? '⚠ ' : 'ℹ '}
                  {note.message}
                </p>
              ))}
              <pre className="json-block">{planText(plan.result)}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

import { useMemo } from 'react';
import type { RequestDetail } from '../api';
import { buildFlamegraph, flameLevels, LABEL_MIN_WIDTH, LEVEL_HEIGHT } from '../flamegraph';
import { duration, spanColor } from '../format';

const LEGEND: Array<[kind: string, label: string]> = [
  ['middleware', 'middleware'],
  ['handler', 'handler'],
  ['db', 'sql'],
  ['http', 'external http'],
  ['cache', 'cache'],
];

/** The same spans as the waterfall, stacked by nesting instead of by time. */
export function Flamegraph({ detail }: { detail: RequestDetail }) {
  const blocks = useMemo(() => buildFlamegraph(detail), [detail]);
  const levels = flameLevels(blocks);

  return (
    <section className="waterfall">
      <div className="waterfall-head">
        <span className="label">FLAMEGRAPH</span>
        <span className="label">
          {detail.spans.length} spans · {duration(detail.durationMs)} total
        </span>
      </div>

      <div className="flame" style={{ height: Math.max(LEVEL_HEIGHT, levels * LEVEL_HEIGHT + 2) }}>
        {blocks.map((block) => (
          <span
            key={block.key}
            className="flame-block"
            style={{
              left: `${block.left}%`,
              width: `${block.width}%`,
              top: block.depth * LEVEL_HEIGHT + 1,
              background: spanColor(block.kind),
            }}
            title={block.title}
          >
            {/* Text only where it can be read: no measurement, just a share
                of the width. */}
            {block.width >= LABEL_MIN_WIDTH ? (
              <span className="flame-label">{block.label}</span>
            ) : null}
          </span>
        ))}
      </div>

      <div className="flame-legend">
        {LEGEND.map(([kind, label]) => (
          <span key={kind} className="flame-key">
            <span className="wf-swatch" style={{ background: spanColor(kind) }} />
            {label}
          </span>
        ))}
      </div>
    </section>
  );
}

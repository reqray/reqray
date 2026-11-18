import type { Span } from '../../../api/index';

export type CacheOperation = Extract<Span, { kind: 'cache' }>;

interface CacheRowProps {
  operation: CacheOperation;
  /** How many times this exact read was made in the request. */
  reads: number;
}

/** One cache call: what was asked, of which key, and what came back. */
export function CacheRow({ operation, reads }: CacheRowProps) {
  const repeated = operation.operation === 'get' && reads > 1;

  return (
    <div className="cache-row">
      <span>{operation.command ?? operation.operation.toUpperCase()}</span>
      <span className="ellipsis">
        {operation.key}
        {repeated ? <span className="dup-mark">DUP ×{reads}</span> : null}
      </span>
      <span className={`cell-right ${operation.hit ? 's-ok' : 's-warn'}`}>
        {operation.hit === null ? 'OK' : operation.hit ? 'HIT' : 'MISS'}
      </span>
      <span className="cell-right">{operation.duration.toFixed(1)}</span>
    </div>
  );
}

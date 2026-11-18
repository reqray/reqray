import type { RequestDetail } from '../../../api/index';
import { cacheCall } from '../../../shared/format';
import { type CacheOperation, CacheRow } from '../parts/CacheRow';

interface CacheTabProps {
  detail: RequestDetail;
}

export function CacheTab({ detail }: CacheTabProps) {
  const operations = detail.spans.filter((span): span is CacheOperation => span.kind === 'cache');
  if (operations.length === 0) return <p className="s-dim mono">no cache operations</p>;

  // How many times each read is repeated: the same read twice in one request
  // is work that did not need doing, and the detector says so on the findings
  // block — here it is marked where it happened. Counted by the whole call,
  // so two reads of different fields of one hash are not called a duplicate.
  const reads = new Map<string, number>();
  for (const operation of operations) {
    if (operation.operation === 'get')
      reads.set(cacheCall(operation), (reads.get(cacheCall(operation)) ?? 0) + 1);
  }

  return (
    <div>
      <div className="cache-row label">
        <span>COMMAND</span>
        <span>KEY</span>
        <span className="cell-right">RESULT</span>
        <span className="cell-right">MS</span>
      </div>
      {operations.map((operation) => (
        <CacheRow
          key={operation.id}
          operation={operation}
          reads={reads.get(cacheCall(operation)) ?? 0}
        />
      ))}
    </div>
  );
}

import type { ProjectReport } from '../../../api/index';
import { count } from '../../../shared/format';
import { Fact } from './Fact';

interface PoolsProps {
  pools: ProjectReport['pools'];
  onRead: () => void;
}

/**
 * Every connection pool the application has queried through.
 *
 * The one thing on this screen that cannot be reconstructed from a recorded
 * request: a span says a query waited, and only the pool says whether it was
 * the last free connection or the fortieth request in a queue.
 */
export function Pools({ pools, onRead }: PoolsProps) {
  return (
    <>
      {pools.map((pool, index) => (
        <Fact
          key={pool.id}
          label={pools.length === 1 ? pool.source : `${pool.source} #${index + 1}`}
        >
          {pool.total} of {pool.max} connections open · {pool.idle} idle
          {pool.waiting > 0 ? (
            <span className="s-warn"> · {count(pool.waiting)} queued right now</span>
          ) : null}
        </Fact>
      ))}
      <button type="button" className="link-button" onClick={onRead}>
        read again
      </button>
    </>
  );
}

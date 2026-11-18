import { fetchProject } from '../../api/index';
import { ago, bytes, count, duration } from '../../shared/format';
import { useLiveQuery } from '../../shared/useLiveQuery';
import { Detectors } from './parts/Detectors';
import { Fact } from './parts/Fact';
import { Flag } from './parts/Flag';
import { Instrumentation } from './parts/Instrumentation';
import { Pools } from './parts/Pools';
import { RetentionCard } from './parts/RetentionCard';

export function ProjectScreen() {
  // Re-asked after retention changes and pool reads: seeing the new numbers
  // is the point of having acted.
  const { data: report, error, reload } = useLiveQuery(fetchProject);

  if (error) return <p className="s-err mono">{error}</p>;
  if (!report) return <p className="s-dim mono">reading the project…</p>;

  const { app, runtime, reqray, storage, pools } = report;

  return (
    <div className="project">
      <section className="panel-card">
        <div className="label">INSTRUMENTATION</div>
        <Instrumentation report={report} />
      </section>

      <RetentionCard report={report} onChanged={reload} />

      <div className="project-columns">
        <section className="panel-card">
          <div className="label">APPLICATION</div>
          <Fact label="name">
            {app.name ?? 'unnamed'}
            {app.version ? <span className="s-fg2"> {app.version}</span> : null}
          </Fact>
          <Fact label="root">{app.root}</Fact>
          <Fact label="commit">
            {app.git ? (
              <>
                {app.git.branch ?? 'detached'}
                <span className="s-fg2"> · {app.git.sha}</span>
                {app.git.dirty ? <span className="s-warn"> · uncommitted changes</span> : null}
              </>
            ) : (
              <span className="s-dim">not a git checkout</span>
            )}
          </Fact>
          <Fact label="node">
            {runtime.node} · {runtime.platform} {runtime.arch}
          </Fact>
          <Fact label="process">
            pid {runtime.pid} · up {duration(Date.now() - runtime.startedAt)}
          </Fact>
          <Fact label="memory">
            {runtime.rssMb.toFixed(0)} MB rss · {runtime.heapUsedMb.toFixed(0)} MB heap
          </Fact>
        </section>

        <section className="panel-card">
          <div className="label">RECORDING</div>
          <Fact label="mode">
            {reqray.mode}
            {reqray.enabled ? '' : ' · disabled'}
            {reqray.version ? <span className="s-fg2"> · reqray {reqray.version}</span> : null}
          </Fact>
          <Fact label="storage">
            {storage ? (
              <>
                {storage.name} · {count(storage.size)}
                {storage.capacity ? ` of ${count(storage.capacity)}` : ''}
                {storage.bytes !== null ? ` · ${bytes(storage.bytes)}` : ''}
                {storage.oldestAt ? (
                  <span className="s-fg2"> · oldest {ago(storage.oldestAt)}</span>
                ) : null}
              </>
            ) : (
              <span className="s-dim">the store keeps its own counsel</span>
            )}
          </Fact>
          <Fact label="sampling">
            {/* When everything is kept, the exceptions to the rule are not
                worth printing: "always over 0 ms" is noise, not a setting. */}
            {reqray.sampling.rate >= 1 ? (
              'everything'
            ) : (
              <>
                {(reqray.sampling.rate * 100).toFixed(1)}% of ordinary requests
                <span className="s-fg2">
                  {reqray.sampling.slowMs > 0 ? ` · always over ${reqray.sampling.slowMs} ms` : ''}
                  {reqray.sampling.alwaysOnError ? ' · always on error' : ''}
                  {reqray.sampling.alwaysOnFinding ? ' · always on a finding' : ''}
                </span>
              </>
            )}
          </Fact>
          <Fact label="limits">
            {count(reqray.maxSpansPerRequest)} spans per request · {count(reqray.stack.limit)} stack
            frames
          </Fact>
          <Fact label="panel">
            {reqray.panel ? (
              <>
                {reqray.panel.path}
                {reqray.panel.gated ? (
                  <span className="s-ok"> · gated</span>
                ) : (
                  <span className="s-warn"> · open</span>
                )}
              </>
            ) : (
              <span className="s-dim">not mounted</span>
            )}
          </Fact>
          <Fact label="features">
            <Flag on={reqray.replay}>replay</Flag>
            <Flag on={reqray.explain}>explain</Flag>
            <Flag on={reqray.blame}>blame</Flag>
            <Flag on={reqray.logs}>logs</Flag>
            <Flag on={reqray.collectSqlValues}>sql values</Flag>
          </Fact>
        </section>
      </div>

      {pools.length > 0 ? (
        <section className="panel-card">
          <div className="label">CONNECTION POOLS</div>
          {/* A reading, not a recording. `max` and the connections open are
              facts about how the pool is set up; the queue is a fact about
              this instant and is gone by the time it is read aloud — so it
              is shown only when there is one, and the button says plainly
              that seeing it again means asking again. */}
          <Pools pools={pools} onRead={reload} />
        </section>
      ) : null}

      <div className="project-columns">
        <section className="panel-card">
          <div className="label">DETECTORS</div>
          <Detectors detect={reqray.detect} />
        </section>

        <section className="panel-card">
          <div className="label">MASKED BEFORE STORING</div>
          {/* Field names, not values: this is the list to check when a custom
              one was added and something still looks unmasked. */}
          <Fact label="headers">{reqray.redact.headers.join(' · ')}</Fact>
          <Fact label="body fields">{reqray.redact.body.join(' · ')}</Fact>
        </section>
      </div>
    </div>
  );
}

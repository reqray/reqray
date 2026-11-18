/**
 * Transaction-hold detector.
 *
 * The cases that must stay silent carry most of the weight. This detector
 * reads two things at once — SQL and outgoing calls — and the temptation it
 * has to resist is deciding that anything happening at the same time as a
 * transaction happened inside it.
 */

import { transactionHold } from '@reqray/core';
import { describe, expect, it } from 'vitest';
import { scenario } from '../fixtures/spans.js';

const options = transactionHold.defaultOptions;
const finished = (durationMs = 1_000) => ({
  durationMs,
  status: 200,
  bytesOut: null,
  contentType: null,
});

describe('transaction_hold — finds it', () => {
  it('reports an outgoing call made while a transaction was open', () => {
    const scope = scenario()
      .transaction((tx) => {
        tx.query({ sql: 'UPDATE orders SET paid = true WHERE id = $1', duration: 2 });
        tx.call({ url: 'https://api.stripe.com/v1/charges?key=x', duration: 300, method: 'POST' });
        tx.query({ sql: 'INSERT INTO payments (order_id) VALUES ($1)', duration: 2 });
      })
      .done();

    const findings = transactionHold.run(scope, options, finished());

    expect(findings).toHaveLength(1);
    expect(findings[0]?.detector).toBe('transaction_hold');
    expect(findings[0]?.severity).toBe('critical');
    expect(findings[0]?.title).toBe('A transaction held a connection through a 300 ms call');
    expect(findings[0]?.evidence).toMatchObject({
      kind: 'transaction',
      externalMs: 300,
      queries: 2,
      sample: 'POST https://api.stripe.com/v1/charges',
      closedBy: 'COMMIT',
    });
  });

  it('costs nothing in milliseconds, because the time is somebody else’s', () => {
    const scope = scenario()
      .transaction((tx) => {
        tx.call({ url: 'https://api.stripe.com/v1/charges', duration: 300 });
      })
      .done();

    // Moving the call out does not make this request faster — it gives the
    // connection back sooner, and that shows up in other requests.
    expect(transactionHold.run(scope, options, finished())[0]?.costMs).toBe(0);
  });

  it('points at the call rather than at the BEGIN', () => {
    const scope = scenario()
      .transaction((tx) => {
        tx.call({
          url: 'https://api.stripe.com/v1/charges',
          duration: 200,
          callsite: 'src/checkout.ts:88',
        });
      })
      .done();

    expect(transactionHold.run(scope, options, finished())[0]?.callsite?.relative).toBe(
      'src/checkout.ts',
    );
  });

  it('counts two concurrent calls as one hold, not two', () => {
    const scope = scenario()
      .transaction((tx) => {
        tx.callParallel(2, (index) => ({
          url: `https://api.example.com/${index}`,
          duration: 120,
        }));
      })
      .done();

    const [finding] = transactionHold.run(scope, options, finished());

    expect(finding?.evidence).toMatchObject({ externalMs: 120 });
    expect(finding?.title).toBe('A transaction held a connection through 2 calls');
  });

  it('counts only the part of a call that overlapped the open window', () => {
    // The call started while the transaction was open and was still running
    // after the `COMMIT`. Only the overlap was time with a connection in
    // hand, and only the overlap is what the finding may claim.
    const scope = scenario()
      .transaction((tx) => {
        tx.pause(100);
        tx.query({ sql: 'SELECT 1', duration: 1 });
        tx.pause(100);
      })
      .call({ url: 'https://api.example.com/slow', duration: 300, at: 150 })
      .done();

    const [finding] = transactionHold.run(scope, options, finished());
    const evidence = finding?.evidence.kind === 'transaction' ? finding.evidence : null;

    // The window closes at 201.4; the call runs 150 → 450.
    expect(evidence?.externalMs).toBeCloseTo(51.4, 5);
    expect(evidence?.heldMs).toBeCloseTo(201.4, 5);
  });

  it('reports a long hold that was not spent querying', () => {
    const scope = scenario()
      .transaction((tx) => {
        tx.query({ sql: 'SELECT * FROM orders FOR UPDATE', duration: 40 });
        tx.pause(700);
        tx.query({ sql: 'UPDATE orders SET state = $1', duration: 3 });
      })
      .done();

    const [finding] = transactionHold.run(scope, options, finished());

    expect(finding?.severity).toBe('warn');
    expect(finding?.title).toMatch(
      /^A transaction held a connection for 74\d ms, 4\d ms of it querying$/,
    );
    expect(finding?.costMs).toBe(0);
  });

  it('names how the transaction ended', () => {
    const scope = scenario()
      .transaction(
        (tx) => {
          tx.query({ sql: 'UPDATE orders SET state = $1', duration: 20 });
          tx.pause(700);
        },
        { close: 'ROLLBACK' },
      )
      .done();

    expect(transactionHold.run(scope, options, finished())[0]?.evidence).toMatchObject({
      closedBy: 'ROLLBACK',
    });
  });

  it('holds an unclosed transaction open until the request ends', () => {
    const scope = scenario()
      .transaction(
        (tx) => {
          tx.query({ sql: 'UPDATE orders SET state = $1', duration: 5 });
        },
        { close: null },
      )
      .done();

    const [finding] = transactionHold.run(scope, options, finished(900));
    const evidence = finding?.evidence.kind === 'transaction' ? finding.evidence : null;

    expect(evidence?.closedBy).toBeNull();
    expect(evidence?.heldMs).toBe(900);
  });
});

describe('transaction_hold — does not find it', () => {
  it('says nothing about a call made after the COMMIT', () => {
    const scope = scenario()
      .transaction((tx) => {
        tx.query({ sql: 'UPDATE orders SET paid = true', duration: 3 });
      })
      .call({ url: 'https://api.stripe.com/v1/charges', duration: 400 })
      .done();

    expect(transactionHold.run(scope, options, finished())).toEqual([]);
  });

  it('says nothing about a call made before the BEGIN', () => {
    const scope = scenario()
      .call({ url: 'https://api.stripe.com/v1/charges', duration: 400 })
      .transaction((tx) => {
        tx.query({ sql: 'UPDATE orders SET paid = true', duration: 3 });
      })
      .done();

    expect(transactionHold.run(scope, options, finished())).toEqual([]);
  });

  it('does not count a query that ran on another connection', () => {
    const scope = scenario()
      .transaction((tx) => {
        tx.query({ sql: 'UPDATE orders SET paid = true', duration: 2 });
        // A parallel read through the pool: same moment, different wire.
        tx.query({ sql: 'SELECT * FROM users', duration: 300, connection: 99 });
        tx.pause(400);
      })
      .done();

    const [finding] = transactionHold.run(scope, options, finished());

    expect(finding?.evidence).toMatchObject({ queries: 1 });
  });

  it('says nothing when there is no explicit transaction', () => {
    // Every write is an implicit single-statement transaction. That is not
    // what this detector is about, and saying so on every request would be
    // the fastest way to get it switched off.
    const scope = scenario()
      .query({ sql: 'UPDATE orders SET paid = true', duration: 2, connection: 1 })
      .call({ url: 'https://api.stripe.com/v1/charges', duration: 400 })
      .done();

    expect(transactionHold.run(scope, options, finished())).toEqual([]);
  });

  it('says nothing about a short transaction with a short call', () => {
    const scope = scenario()
      .transaction((tx) => {
        tx.query({ sql: 'UPDATE counters SET n = n + 1', duration: 2 });
        tx.call({ url: 'https://cache.internal/warm', duration: 8 });
      })
      .done();

    expect(transactionHold.run(scope, options, finished())).toEqual([]);
  });

  it('says nothing about a long transaction that was busy querying', () => {
    // Slow queries are a finding of their own, and the panel already makes
    // it. Repeating it in different words teaches people to skim.
    const scope = scenario()
      .transaction((tx) => {
        tx.query({ sql: 'UPDATE big_table SET x = 1', duration: 900 });
      })
      .done();

    expect(transactionHold.run(scope, options, finished())).toEqual([]);
  });

  it('does not treat ROLLBACK TO SAVEPOINT as the end of a transaction', () => {
    const scope = scenario()
      .transaction((tx) => {
        tx.query({ sql: 'SAVEPOINT retry', duration: 0.2 });
        tx.query({ sql: 'ROLLBACK TO SAVEPOINT retry', duration: 0.2 });
        tx.call({ url: 'https://api.stripe.com/v1/charges', duration: 300 });
      })
      .done();

    const findings = transactionHold.run(scope, options, finished());

    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toMatchObject({ externalMs: 300, closedBy: 'COMMIT' });
  });

  it('reports one finding per transaction even when both shapes apply', () => {
    const scope = scenario()
      .transaction((tx) => {
        tx.call({ url: 'https://api.stripe.com/v1/charges', duration: 300 });
        tx.pause(600);
      })
      .done();

    expect(transactionHold.run(scope, options, finished())).toHaveLength(1);
  });

  it('can be switched off by raising its floors', () => {
    const scope = scenario()
      .transaction((tx) => {
        tx.call({ url: 'https://api.stripe.com/v1/charges', duration: 300 });
      })
      .done();

    expect(
      transactionHold.run(
        scope,
        { ...options, minExternalMs: 1_000, maxHeldMs: 10_000 },
        finished(),
      ),
    ).toEqual([]);
  });
});

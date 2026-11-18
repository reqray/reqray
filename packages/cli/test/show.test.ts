/**
 * One request, drawn.
 *
 * The waterfall is arithmetic — a bar that rounds the wrong way is a bar that
 * lies about where the time went — so the arithmetic is checked on its own,
 * and the screens are checked as snapshots.
 */

import { describe, expect, it } from 'vitest';
import { detailScreen } from '../src/render/detail.js';
import { findingLines, ranked } from '../src/render/findings.js';
import { queriesOf, sqlLines, wrapSql } from '../src/render/sql.js';
import { plainTheme, resolveTheme } from '../src/render/theme.js';
import { bar, barCells, buildWaterfall, ruler, scale, sqlLabel } from '../src/render/waterfall.js';
import {
  failedRequest,
  heavyExport,
  longPathRequest,
  longSqlRequest,
  ordersWithNPlusOne,
  quietRequest,
} from './fixtures/records.js';
import { readable, strip } from './fixtures/text.js';

describe('the whole screen', () => {
  it('a request with an N+1, at 100 columns', async () => {
    await expect(readable(detailScreen(ordersWithNPlusOne(), plainTheme(100)))).toMatchFileSnapshot(
      './__snapshots__/show-nplus1.txt',
    );
  });

  it('the same request with colour', async () => {
    const theme = resolveTheme({ COLUMNS: '100' }, { isTTY: true }, { color: 'always' });
    await expect(readable(detailScreen(ordersWithNPlusOne(), theme))).toMatchFileSnapshot(
      './__snapshots__/show-nplus1-colour.txt',
    );
  });

  it('the same request without unicode', async () => {
    await expect(
      readable(detailScreen(ordersWithNPlusOne(), plainTheme(100, false))),
    ).toMatchFileSnapshot('./__snapshots__/show-nplus1-ascii.txt');
  });

  it('the same request at 200 columns', async () => {
    await expect(readable(detailScreen(ordersWithNPlusOne(), plainTheme(200)))).toMatchFileSnapshot(
      './__snapshots__/show-nplus1-200.txt',
    );
  });

  it('the same request while the loop was behind', async () => {
    const detail = ordersWithNPlusOne();
    const blocked = { ...detail, host: { loopDelayMs: 42.5, loopMaxMs: 184.9 } };

    await expect(readable(detailScreen(blocked, plainTheme(100)))).toMatchFileSnapshot(
      './__snapshots__/show-nplus1-loop.txt',
    );
  });

  it('says nothing about a loop that was on time', async () => {
    const detail = ordersWithNPlusOne();
    // Under one sampling interval of lateness there is nothing to report but
    // the granularity of the measurement itself.
    const fine = { ...detail, host: { loopDelayMs: 0.4, loopMaxMs: 1.2 } };

    const screen = strip(detailScreen(fine, plainTheme(100))).join('\n');
    expect(screen).not.toContain('loop behind');
  });

  it('the same request at 80, where the breakdown has to give something up', async () => {
    await expect(readable(detailScreen(ordersWithNPlusOne(), plainTheme(80)))).toMatchFileSnapshot(
      './__snapshots__/show-nplus1-80.txt',
    );
  });

  it('the same request judged against its route', async () => {
    const compared = {
      baseline: {
        method: 'GET',
        route: '/api/orders',
        samples: 47,
        windowMs: 900_000,
        avgMs: 61.4,
        p95Ms: 210.2,
        p50Ms: 48.1,
        p99Ms: 402.7,
        maxMs: 511.3,
        verdict: 'slower' as const,
      },
      pressure: null,
    };
    await expect(
      readable(detailScreen(ordersWithNPlusOne(), plainTheme(100), compared)),
    ).toMatchFileSnapshot('./__snapshots__/show-nplus1-baseline.txt');
  });

  it('the same request, with the process under strain while it ran', async () => {
    const compared = {
      baseline: {
        method: 'GET',
        route: '/api/orders',
        samples: 47,
        windowMs: 900_000,
        avgMs: 61.4,
        p95Ms: 210.2,
        p50Ms: 48.1,
        p99Ms: 402.7,
        maxMs: 511.3,
        verdict: 'slower' as const,
      },
      pressure: {
        metric: 'loop' as const,
        cutoffMs: 37.2,
        ratio: 1.84,
        share: 24,
        elevated: { calls: 24, p95Ms: 512, avgMs: 310 },
        normal: { calls: 76, p95Ms: 278, avgMs: 120 },
      },
    };
    await expect(
      readable(detailScreen(ordersWithNPlusOne(), plainTheme(100), compared)),
    ).toMatchFileSnapshot('./__snapshots__/show-nplus1-pressure.txt');

    // And at 80, where the sentence has to give up its words rather than
    // wrap: what survives is the cutoff, the ratio and the share.
    await expect(
      readable(detailScreen(ordersWithNPlusOne(), plainTheme(80), compared)),
    ).toMatchFileSnapshot('./__snapshots__/show-nplus1-pressure-80.txt');
  });

  it('an export that returned megabytes', async () => {
    // What it costs is bytes and rows. The column that reads "41.2ms · 15% of
    // total" for an N+1 must not read "0ms · 0% of total" here.
    await expect(readable(detailScreen(heavyExport(), plainTheme(100)))).toMatchFileSnapshot(
      './__snapshots__/show-heavy.txt',
    );
  });

  it('a request the detectors had nothing to say about, at 80', async () => {
    await expect(readable(detailScreen(quietRequest(), plainTheme(80)))).toMatchFileSnapshot(
      './__snapshots__/show-quiet.txt',
    );
  });

  it('a request that threw', async () => {
    await expect(readable(detailScreen(failedRequest(), plainTheme(100)))).toMatchFileSnapshot(
      './__snapshots__/show-failed.txt',
    );
  });

  it('a request whose path is longer than the screen', async () => {
    await expect(readable(detailScreen(longPathRequest(), plainTheme(80)))).toMatchFileSnapshot(
      './__snapshots__/show-long-path.txt',
    );
  });

  it('has no findings block when there are none', () => {
    expect(detailScreen(quietRequest(), plainTheme(80)).join('\n')).not.toContain('FINDINGS');
  });

  it('is the same layout with colour and without', () => {
    const painted = resolveTheme({ COLUMNS: '100' }, { isTTY: true }, { color: 'always' });

    expect(strip(detailScreen(ordersWithNPlusOne(), painted))).toEqual(
      detailScreen(ordersWithNPlusOne(), plainTheme(100)),
    );
  });
});

describe('the bar', () => {
  const theme = plainTheme(100);

  it('is as wide as the share of the request it took', () => {
    expect(bar(0, 50, 100, 10, theme)).toBe('█████     ');
    expect(bar(50, 50, 100, 10, theme)).toBe('     █████');
  });

  it('draws a span shorter than a cell rather than losing it', () => {
    expect(bar(0, 0.1, 100, 10, theme)).toBe('▏         ');
    expect(bar(99, 0.1, 100, 10, theme).trim()).toBe('▏');
  });

  it('never draws past the last cell', () => {
    for (let start = 0; start <= 100; start += 7) {
      expect(bar(start, 40, 100, 20, theme)).toHaveLength(20);
    }
  });

  it('draws a handler as a bracket, because it is a container, not work', () => {
    expect(bar(0, 100, 100, 10, theme, true)).toBe('├────────┤');
  });

  it('is 45 cells at 100 columns, as the specification has it', () => {
    expect(barCells(100)).toBe(45);
    expect(barCells(80)).toBe(25);
    // Wide terminals stop growing it: past a point it is a ruler, not a shape.
    expect(barCells(400)).toBe(60);
  });
});

describe('the scale above it', () => {
  const theme = plainTheme(100);

  it('is five ticks with even runs between them', () => {
    const { line, ticks } = ruler(45, theme);

    expect(line).toHaveLength(45);
    expect(ticks).toEqual([0, 11, 22, 33, 44]);
  });

  it('prints the first time at the left edge and the last at the right', () => {
    const { ticks } = ruler(45, theme);
    const printed = scale(275.3, ticks);

    expect(printed.startsWith('0ms')).toBe(true);
    expect(printed.endsWith('275ms')).toBe(true);
    expect(printed).toHaveLength(45);
  });

  it('may run a little past the ruler, but never past the terminal', () => {
    // The line above the ruler carries nothing else, so it uses the width.
    expect(scale(12.4, ruler(25, theme).ticks, 43)).toBe('0ms 3.1ms 6.2ms 9.3ms 12ms');
  });

  it('prints fewer times when five will not fit', () => {
    const { line, ticks } = ruler(barCells(56), theme);

    expect(line).toHaveLength(barCells(56));
    const printed = scale(1_000, ticks, 56 - 37);
    expect(printed.length).toBeLessThanOrEqual(56 - 37);
    expect(printed).toBe('0ms 500ms 1.00s');
  });
});

describe('span labels', () => {
  it('shorten a query to the table and what selects inside it', () => {
    expect(sqlLabel('SELECT * FROM users WHERE id = $1')).toBe('SELECT users WHERE id=$1');
    expect(sqlLabel('select  a, b\n from "public"."orders" limit 25')).toBe(
      'SELECT orders limit 25',
    );
    expect(sqlLabel('INSERT INTO orders (a, b) VALUES ($1, $2)')).toBe('INSERT orders');
    expect(sqlLabel('UPDATE orders SET status = $1 WHERE id = $2')).toBe(
      'UPDATE orders SET status=$1 WHERE id=$2',
    );
  });

  it('leave anything they do not recognise alone', () => {
    expect(sqlLabel('BEGIN')).toBe('BEGIN');
  });

  it('collapse an N+1 into one row that says how many there were', () => {
    const rows = buildWaterfall(ordersWithNPlusOne(), plainTheme(100));
    const collapsed = rows.filter((row) => row.badge === 'N+1');

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.label.startsWith('47× SELECT line_items')).toBe(true);
    // Fifteen rows for sixty-one spans: the loop is one of them.
    expect(rows).toHaveLength(15);
  });

  it('mark every repeat of a duplicated call except the first', () => {
    const rows = buildWaterfall(ordersWithNPlusOne(), plainTheme(100));

    expect(rows.filter((row) => row.badge === 'DUP')).toHaveLength(2);
  });
});

describe('the findings block', () => {
  it('orders findings by severity first, then by what they cost', () => {
    // The N+1 is critical and costs 41 ms; the duplicate calls are a warning
    // and cost 96. Cost alone would put the warning on top, which reads as
    // the screen ranking by what is measurable rather than by what matters.
    expect(ranked(ordersWithNPlusOne()).map((finding) => finding.detector)).toEqual([
      'n_plus_one',
      'dup_http',
      'dup_cache',
    ]);
  });

  it('lets at most two of them shout', () => {
    const lines = findingLines(ordersWithNPlusOne(), plainTheme(100));
    const loud = lines.filter((line) => line.startsWith('  ! '));

    expect(loud).toHaveLength(2);
    // The third is stated quietly, in lower case, without a gutter mark.
    expect(lines.some((line) => line.startsWith('    dup   '))).toBe(true);
  });

  it('says what it costs, what it points at, and how to fix it', () => {
    const lines = findingLines(ordersWithNPlusOne(), plainTheme(100)).join('\n');

    expect(lines).toContain('47 identical queries in a loop');
    expect(lines).toContain('41.2ms');
    expect(lines).toContain('15% of total');
    expect(lines).toContain('services/orders.js:118');
    expect(lines).toContain('fix   eager-load line_items');
  });
});

describe('the queries', () => {
  it('number every query, with a loop counted once', () => {
    const queries = queriesOf(longSqlRequest());

    expect(queries.map((entry) => entry.ref)).toEqual(['q1', 'q2']);
    expect(queries[1]).toMatchObject({ calls: 47, badge: 'N+1' });
  });

  it('wrap rather than truncate, because a query cannot be recognised in part', () => {
    const wrapped = wrapSql('SELECT a, b, c FROM orders WHERE id = $1', 20);

    expect(wrapped.every((line) => line.length <= 20)).toBe(true);
    expect(wrapped.join(' ')).toBe('SELECT a, b, c FROM orders WHERE id = $1');
  });

  it('the screen, cut at three lines with a way to see the rest', async () => {
    await expect(readable(sqlLines(longSqlRequest(), plainTheme(100)))).toMatchFileSnapshot(
      './__snapshots__/sql-cut.txt',
    );
  });

  it('the whole of one query, when asked', async () => {
    await expect(
      readable(sqlLines(longSqlRequest(), plainTheme(100), { only: 'q1', full: true })),
    ).toMatchFileSnapshot('./__snapshots__/sql-full.txt');
  });

  it('says which queries there are when asked for one that is not', () => {
    const lines = sqlLines(longSqlRequest(), plainTheme(100), { only: 'q9' }).join('\n');

    expect(lines).toContain('no query called q9');
    expect(lines).toContain('q1 q2');
  });

  it('says so plainly when a request ran none', () => {
    expect(sqlLines(longPathRequest(), plainTheme(100)).join('\n')).toContain('ran no queries');
  });
});

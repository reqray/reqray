/**
 * The stream, as it lands on screen.
 *
 * Snapshots at both ends of the width range and with colour on and off,
 * because the promise is that the grid does not move: turning colour off must
 * change bytes and not columns.
 */

import { describe, expect, it } from 'vitest';
import { globOf, matches, matchesStatus } from '../src/filter.js';
import { failureLines, frameOf, streamHead, streamRow } from '../src/render/row.js';
import { plainTheme, resolveTheme, type Theme } from '../src/render/theme.js';
import { failedRequest } from './fixtures/records.js';
import {
  calmRows,
  failedRow,
  longPathRow,
  nPlusOneRow,
  slowRow,
  testRow,
} from './fixtures/rows.js';
import { readable, strip } from './fixtures/text.js';

const everything = [...calmRows(), nPlusOneRow(), slowRow(), testRow(), failedRow(), longPathRow()];

/** The whole stream, drawn by one theme. */
function screen(theme: Theme): string[] {
  return [streamHead(theme), ...everything.map((row) => streamRow(row, theme))];
}

describe('the stream', () => {
  it('at 80 columns', async () => {
    await expect(readable(screen(plainTheme(80)))).toMatchFileSnapshot(
      './__snapshots__/stream-80.txt',
    );
  });

  it('at 200 columns', async () => {
    await expect(readable(screen(plainTheme(200)))).toMatchFileSnapshot(
      './__snapshots__/stream-200.txt',
    );
  });

  it('with colour', async () => {
    const theme = resolveTheme({ COLUMNS: '100' }, { isTTY: true }, { color: 'always' });
    await expect(readable(screen(theme))).toMatchFileSnapshot('./__snapshots__/stream-colour.txt');
  });

  it('without unicode', async () => {
    await expect(readable(screen(plainTheme(100, false)))).toMatchFileSnapshot(
      './__snapshots__/stream-ascii.txt',
    );
  });

  it('with the identifiers, which is how a row on screen gets opened', async () => {
    const theme = plainTheme(100);
    const lines = [
      streamHead(theme, { ids: true }),
      ...everything.map((row) => streamRow(row, theme, { ids: true })),
    ];

    expect(lines[0]).toContain('ID');
    expect(lines[1]).toContain('8970');
    await expect(readable(lines)).toMatchFileSnapshot('./__snapshots__/stream-ids.txt');
  });

  it('narrow enough that columns start being dropped', async () => {
    await expect(readable(screen(plainTheme(60)))).toMatchFileSnapshot(
      './__snapshots__/stream-60.txt',
    );
  });
});

describe('colour is a second layer', () => {
  it('changes not one character of the layout', () => {
    const painted = resolveTheme({ COLUMNS: '100' }, { isTTY: true }, { color: 'always' });

    expect(strip(screen(painted))).toEqual(screen(plainTheme(100)));
  });

  it('leaves every distinction standing when it is off', () => {
    const theme = plainTheme(100);
    const failed = streamRow(failedRow(), theme);

    // Five signals, no colour among them: the gutter, the code, the
    // magnitude, the word, and the continuation line under it.
    expect(failed.startsWith('!!')).toBe(true);
    expect(failed).toContain('500');
    expect(failed).toContain('2.14s');
    expect(failed.trimEnd().endsWith('ERR')).toBe(true);
    expect(failureLines(failedRow(), failedRequest(), theme)[0]).toContain('TypeError');
  });
});

describe('the second line of a failed request', () => {
  it('names the exception, where it came from, and how to open it', () => {
    const lines = failureLines(failedRow(), failedRequest(), plainTheme(100));

    expect(lines[0]).toContain("Cannot read properties of undefined (reading 'currency')");
    expect(lines[1]).toContain('services/pricing.js:61');
    expect(lines[1]).toContain('reqray show 9012');
  });

  it('falls back to the command alone when the detail could not be had', () => {
    expect(failureLines(failedRow(), null, plainTheme(100))).toEqual(['   └ reqray show 9012']);
  });

  it('reads past the frames that are not the application', () => {
    const stack = [
      'TypeError: nope',
      '    at query (/srv/app/node_modules/pg/lib/client.js:520:11)',
      '    at node:internal/process/task_queues:95:5',
      '    at priceOf (/srv/app/services/pricing.js:61:14)',
    ].join('\n');

    expect(frameOf(stack)).toBe('services/pricing.js:61');
    expect(frameOf(null)).toBeNull();
  });
});

describe('narrowing the stream', () => {
  const row = calmRows()[2] as ReturnType<typeof calmRows>[number];

  it('by how long it took', () => {
    expect(matches(row, { slowerThanMs: 10 })).toBe(true);
    expect(matches(row, { slowerThanMs: 100 })).toBe(false);
  });

  it('by status, a code or a class', () => {
    expect(matchesStatus(404, '404')).toBe(true);
    expect(matchesStatus(404, '4xx')).toBe(true);
    expect(matchesStatus(404, '5xx')).toBe(false);
    expect(matches(failedRow(), { statuses: ['5xx'] })).toBe(true);
    expect(matches(row, { statuses: ['5xx'] })).toBe(false);
  });

  it('by method, whatever case it was typed in', () => {
    expect(matches(row, { methods: ['get'] })).toBe(true);
    expect(matches(row, { methods: ['post'] })).toBe(false);
  });

  it('by a glob over the path, which crosses slashes', () => {
    expect(globOf('/api/*').test('/api/orders/8812')).toBe(true);
    expect(matches(row, { path: '/api/*' })).toBe(true);
    expect(matches(row, { path: '/static/*' })).toBe(false);
    // A dot is a character, not "any character".
    expect(globOf('/static/app.js').test('/static/appXjs')).toBe(false);
  });

  it('by whether the detectors said anything', () => {
    expect(matches(nPlusOneRow(), { findingsOnly: true })).toBe(true);
    expect(matches(row, { findingsOnly: true })).toBe(false);
  });

  it('an empty filter keeps everything', () => {
    expect(everything.every((entry) => matches(entry, {}))).toBe(true);
  });
});

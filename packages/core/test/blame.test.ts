import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blameLine, parsePorcelain } from '@reqray/core/panel';
import { clearBlameCache } from '@reqray/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => clearBlameCache());

describe('porcelain parsing', () => {
  const output = [
    'a4f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9 12 12 1',
    'author Maria Orlova',
    'author-mail <m.orlova@example.com>',
    'author-time 1700000000',
    'author-tz +0300',
    'summary fix the pricing rounding',
    '\tconst total = round(sum);',
  ].join('\n');

  it('reads the commit, the author and the date', () => {
    expect(parsePorcelain(output)).toEqual({
      sha: 'a4f1c2d',
      author: 'Maria Orlova',
      at: 1_700_000_000_000,
    });
  });

  it('says nothing about a line that is not committed yet', () => {
    // Git blames uncommitted work to all zeroes; naming that "commit" would
    // be worse than showing nothing.
    const uncommitted = output.replace(/^a4f1c2d3\w+/, '0'.repeat(40));

    expect(parsePorcelain(uncommitted)).toBeNull();
  });

  it('is not fooled by output that is not blame at all', () => {
    expect(parsePorcelain('')).toBeNull();
    expect(parsePorcelain('fatal: no such path')).toBeNull();
  });
});

describe('blaming a real repository', () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'reqray-blame-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Ada Lovelace',
          GIT_AUTHOR_EMAIL: 'ada@example.com',
          GIT_COMMITTER_NAME: 'Ada Lovelace',
          GIT_COMMITTER_EMAIL: 'ada@example.com',
        },
      });

    git('init', '-q');
    writeFileSync(join(dir, 'orders.js'), 'const a = 1;\nconst b = 2;\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Ada Lovelace',
      '-c',
      'user.email=ada@example.com',
      'commit',
      '-qm',
      'first',
    );
    return dir;
  }

  it('names who last touched the line', async () => {
    const dir = repo();
    try {
      const blame = await blameLine(join(dir, 'orders.js'), 2, dir);

      expect(blame?.author).toBe('Ada Lovelace');
      expect(blame?.sha).toMatch(/^[0-9a-f]{7}$/);
      expect(blame?.at).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an untracked file is not an error, just nothing to say', async () => {
    const dir = repo();
    try {
      writeFileSync(join(dir, 'new.js'), 'x\n');

      expect(await blameLine(join(dir, 'new.js'), 1, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a path outside a repository is not an error either', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reqray-norepo-'));
    try {
      writeFileSync(join(dir, 'x.js'), 'x\n');

      expect(await blameLine(join(dir, 'x.js'), 1, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a relative path and a nonsense line', async () => {
    expect(await blameLine('src/orders.js', 1, process.cwd())).toBeNull();
    expect(await blameLine('/srv/app/src/orders.js', 0, process.cwd())).toBeNull();
  });
});

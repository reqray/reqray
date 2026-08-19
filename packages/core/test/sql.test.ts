import { clearSqlCaches, fingerprintSql, sqlOperation } from '@loupe/core';
import { beforeEach, describe, expect, it } from 'vitest';

beforeEach(() => {
  clearSqlCaches();
});

describe('SQL fingerprint', () => {
  it('collapses literals and numbers', () => {
    expect(fingerprintSql("SELECT * FROM users WHERE name = 'Ada' AND age > 30")).toBe(
      'SELECT * FROM users WHERE name = ? AND age > ?',
    );
  });

  it('collapses placeholders of every dialect', () => {
    expect(fingerprintSql('SELECT * FROM t WHERE a = $1 AND b = ? AND c = :name AND d = @p1')).toBe(
      'SELECT * FROM t WHERE a = ? AND b = ? AND c = ? AND d = ?',
    );
  });

  it('maps different values of one query to one fingerprint', () => {
    const first = fingerprintSql('SELECT * FROM line_items WHERE order_id = 8812');
    const second = fingerprintSql('SELECT * FROM line_items WHERE order_id = 4711');

    expect(first).toBe(second);
  });

  it('collapses IN lists of any length', () => {
    const one = fingerprintSql('SELECT * FROM t WHERE id IN (1)');
    const many = fingerprintSql('SELECT * FROM t WHERE id IN (1, 2, 3, 4, 5)');
    const bound = fingerprintSql('SELECT * FROM t WHERE id IN ($1,$2,$3)');

    expect(one).toBe('SELECT * FROM t WHERE id IN (?)');
    expect(many).toBe(one);
    expect(bound).toBe(one);
  });

  it('collapses VALUES batches', () => {
    const two = fingerprintSql('INSERT INTO t (a, b) VALUES (1, 2), (3, 4)');
    const four = fingerprintSql('INSERT INTO t (a, b) VALUES (1,2),(3,4),(5,6),(7,8)');

    expect(two).toBe('INSERT INTO t (a, b) VALUES (?, ?)');
    expect(four).toBe('INSERT INTO t (a, b) VALUES (?,?)');
  });

  it('reduces whitespace and newlines to a single space', () => {
    expect(fingerprintSql('SELECT   a,\n\tb\n  FROM   t')).toBe('SELECT a, b FROM t');
  });

  it('strips comments', () => {
    expect(fingerprintSql('SELECT a -- why though\nFROM t /* and this too */ WHERE b = 1')).toBe(
      'SELECT a FROM t WHERE b = ?',
    );
  });

  it('does not confuse string contents with syntax', () => {
    expect(fingerprintSql("SELECT * FROM t WHERE note = 'a -- not a comment'")).toBe(
      'SELECT * FROM t WHERE note = ?',
    );
    expect(fingerprintSql("SELECT * FROM t WHERE note = 'a quote '' inside' AND b = 1")).toBe(
      'SELECT * FROM t WHERE note = ? AND b = ?',
    );
    expect(fingerprintSql("SELECT * FROM t WHERE note = 'an escaped \\' inside' AND b = 1")).toBe(
      'SELECT * FROM t WHERE note = ? AND b = ?',
    );
  });

  it('keeps quoted identifiers — they are names, not values', () => {
    expect(fingerprintSql('SELECT "userId" FROM "Order" WHERE "id" = 1')).toBe(
      'SELECT "userId" FROM "Order" WHERE "id" = ?',
    );
    expect(fingerprintSql('SELECT `id` FROM `orders` WHERE `id` = 1')).toBe(
      'SELECT `id` FROM `orders` WHERE `id` = ?',
    );
  });

  it('does not mistake a type cast for a named parameter', () => {
    expect(fingerprintSql("SELECT id::text FROM t WHERE created_at > '2026-01-01'::date")).toBe(
      'SELECT id::text FROM t WHERE created_at > ?::date',
    );
  });

  it('collapses Postgres dollar-quoted strings', () => {
    expect(fingerprintSql('SELECT $$arbitrary text$$ FROM t')).toBe('SELECT ? FROM t');
    expect(fingerprintSql('SELECT $tag$ text $tag$ FROM t')).toBe('SELECT ? FROM t');
  });

  it('survives decimals and exponents', () => {
    expect(fingerprintSql('SELECT * FROM t WHERE price > 10.5 AND ratio < 1.2e-3')).toBe(
      'SELECT * FROM t WHERE price > ? AND ratio < ?',
    );
  });

  it('does not break on fragments', () => {
    expect(() => fingerprintSql('')).not.toThrow();
    expect(() => fingerprintSql("SELECT 'unterminated string")).not.toThrow();
    expect(() => fingerprintSql('SELECT /* unterminated comment')).not.toThrow();
  });

  it('the cache does not change the result', () => {
    const sql = 'SELECT * FROM t WHERE id = 1';
    expect(fingerprintSql(sql)).toBe(fingerprintSql(sql));
  });
});

describe('operation type', () => {
  it('tells the basic operations apart', () => {
    expect(sqlOperation('SELECT * FROM t')).toBe('select');
    expect(sqlOperation('insert into t (a) values (?)')).toBe('insert');
    expect(sqlOperation('UPDATE t SET a = ?')).toBe('update');
    expect(sqlOperation('DELETE FROM t WHERE id = ?')).toBe('delete');
    expect(sqlOperation('BEGIN')).toBe('other');
  });

  it('sees the top-level operation behind a CTE', () => {
    expect(sqlOperation('WITH recent AS (SELECT id FROM t) SELECT * FROM recent')).toBe('select');
    expect(sqlOperation('WITH doomed AS (SELECT id FROM t) DELETE FROM t WHERE id IN (?)')).toBe(
      'delete',
    );
  });

  it('does not look into subqueries', () => {
    expect(sqlOperation('UPDATE t SET a = (SELECT max(b) FROM u)')).toBe('update');
  });

  it('does not take a keyword in a comment for the operation', () => {
    expect(sqlOperation('/* SELECT here is irrelevant */ UPDATE t SET a = ?')).toBe('update');
  });
});

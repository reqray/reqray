import { current, nPlusOne, record, resolveOptions, setLogSink } from '@reqray/core';
import { resetWarnings } from '@reqray/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolving options', () => {
  it('enabled by default outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const options = resolveOptions();

    expect(options.enabled).toBe(true);
    expect(options.mode).toBe('development');
  });

  it('disabled by default in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const options = resolveOptions();

    expect(options.enabled).toBe(false);
    expect(options.mode).toBe('production');
  });

  it('an explicit value beats NODE_ENV', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(resolveOptions({ enabled: true }).enabled).toBe(true);
    expect(resolveOptions({ mode: 'development' }).mode).toBe('development');
  });

  it('stack capture is limited in production and unlimited in development', () => {
    expect(resolveOptions({ mode: 'production' }).stack.maxPerFingerprint).toBe(3);
    expect(resolveOptions({ mode: 'development' }).stack.maxPerFingerprint).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('a finding retains the request only outside production', () => {
    // In production this default would make the detectors run on every
    // request just to decide retention; expensive N+1s are caught by the
    // slow-request rule there instead.
    expect(resolveOptions({ mode: 'production' }).sampling.alwaysOnFinding).toBe(false);
    expect(resolveOptions({ mode: 'development' }).sampling.alwaysOnFinding).toBe(true);
    expect(
      resolveOptions({ mode: 'production', sampling: { alwaysOnFinding: true } }).sampling
        .alwaysOnFinding,
    ).toBe(true);
  });

  it('defaults match the documented contract', () => {
    const options = resolveOptions({ mode: 'development' });

    expect(options.bufferSize).toBe(500);
    expect(options.redact.headers).toEqual(
      expect.arrayContaining(['authorization', 'cookie', 'setcookie']),
    );
    expect(options.redact.body).toEqual(
      expect.arrayContaining(['password', 'token', 'secret', 'cardnumber']),
    );
  });

  it('redaction patterns are normalized once, not on the hot path', () => {
    const options = resolveOptions({ redact: { headers: ['X-Api-Key'], body: ['API_Secret'] } });

    expect(options.redact.headers).toContain('xapikey');
    expect(options.redact.body).toContain('apisecret');
  });

  it('the result is frozen — options do not change on the fly', () => {
    const options = resolveOptions();
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.redact)).toBe(true);
    expect(Object.isFrozen(options.stack)).toBe(true);
  });
});

describe('disabled Reqray', () => {
  it('disabled by default in production: no scope is created and recording is zero work', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(resolveOptions().enabled).toBe(false);
    // Only the adapter creates a scope, and only when `enabled`. With no
    // scope, every instrumentation bails out on its very first check.
    expect(current()).toBeUndefined();
    expect(
      record(current(), { kind: 'db', sql: 'SELECT 1', fingerprint: 'SELECT ?', duration: 1 }),
    ).toBeNull();
  });

  it('an explicit production mode switches it off, whatever NODE_ENV says', () => {
    // One question, one answer: `enabled` follows the mode, not a second
    // reading of the environment the mode was decided from.
    vi.stubEnv('NODE_ENV', 'development');
    const options = resolveOptions({ mode: 'production' });

    expect(options.mode).toBe('production');
    expect(options.enabled).toBe(false);
  });

  it('an option the detector does not have is refused, out loud', () => {
    // From JavaScript nothing type-checks this, and silently freezing a typo
    // into the options means watching a threshold you think you raised do
    // nothing at all.
    const lines: string[] = [];
    resetWarnings();
    setLogSink({ info: () => undefined, warn: (message) => void lines.push(message) });

    const options = resolveOptions({
      detect: { nPlusOne: { treshold: 10 } as never },
    });

    expect(options.detect.nPlusOne).not.toHaveProperty('treshold');
    expect(options.detect.nPlusOne?.threshold).toBe(nPlusOne.defaultOptions.threshold);
    expect(lines[0]).toContain('n_plus_one has no option "treshold"');
    setLogSink(null);
  });

  it('an explicit development mode keeps it on in a production environment', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const options = resolveOptions({ mode: 'development' });

    expect(options.enabled).toBe(true);
    // The environment is still not local: the panel gate is decided by where
    // the process actually runs, not by what it was asked to pretend.
    expect(options.isLocalDevelopment).toBe(false);
  });
});

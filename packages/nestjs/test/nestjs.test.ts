/**
 * The adapter contract, checked on both Nest platforms with real HTTP: the
 * suite is parameterized, because the promise is "one module, any platform".
 */

import 'reflect-metadata';

import {
  type ArgumentsHost,
  Body,
  Catch,
  Controller,
  type ExceptionFilter,
  Get,
  type INestApplication,
  Post,
  type Provider,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { current, fingerprintSql, type RecordedRequest, record } from '@reqray/core';
import { ReqrayModule } from '@reqray/nestjs';
import { type MemoryStore, memoryTransport } from '@reqray/store-memory';
import { afterEach, describe, expect, it } from 'vitest';

function fakeQuery(sql: string, duration: number, startTime: number): void {
  record(current(), {
    kind: 'db',
    sql,
    fingerprint: fingerprintSql(sql),
    duration,
    startTime,
    source: 'pg',
    callsite: { file: '/srv/app/src/orders.ts', relative: 'src/orders.ts', line: 118, column: 3 },
  });
}

@Controller()
class OrdersController {
  @Get('orders')
  orders() {
    fakeQuery('SELECT id FROM orders WHERE user_id = 1', 8, performance.now());
    return { orders: [1, 2] };
  }

  @Get('n-plus-one')
  nPlusOne() {
    let cursor = performance.now();
    for (let i = 0; i < 20; i++) {
      fakeQuery(`SELECT * FROM line_items WHERE order_id = ${i}`, 3, cursor);
      cursor += 3;
    }
    return { ok: true };
  }

  @Post('login')
  login(@Body() _body: unknown) {
    return { token: 'issued-secret', user: 'ada' };
  }

  @Get('boom')
  boom(): never {
    throw new TypeError('handler crashed');
  }
}

/** The application's own catch-all: what it tells a client when it breaks. */
@Catch()
class AppErrorFilter implements ExceptionFilter {
  catch(_exception: unknown, host: ArgumentsHost): void {
    // `status().send()` is the one spelling both platforms' replies share.
    host
      .switchToHttp()
      .getResponse<{ status(code: number): { send(body: unknown): void } }>()
      .status(503)
      .send({ handledBy: 'the application' });
  }
}

interface Harness {
  readonly app: INestApplication;
  readonly store: MemoryStore;
  readonly base: string;
}

const apps: INestApplication[] = [];

async function harness(
  platform: 'express' | 'fastify',
  providers: Provider[] = [],
): Promise<Harness> {
  const store = memoryTransport();
  const moduleRef = await Test.createTestingModule({
    imports: [ReqrayModule.forRoot({ mode: 'development', transport: store })],
    controllers: [OrdersController],
    providers,
  }).compile();

  const app =
    platform === 'fastify'
      ? moduleRef.createNestApplication(new FastifyAdapter())
      : moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  apps.push(app);

  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return { app, store, base };
}

async function waitForRecord(store: MemoryStore, count = 1): Promise<RecordedRequest> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const list = store.list();
    if (list.length >= count) return list[0] as RecordedRequest;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the record never appeared in the transport');
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

describe.each(['express', 'fastify'] as const)('platform %s', (platform) => {
  it('records a request with an SQL span from the service', async () => {
    const { store, base } = await harness(platform);

    const response = await fetch(`${base}/orders`);
    expect(response.status).toBe(200);

    const recorded = await waitForRecord(store);
    expect(recorded.method).toBe('GET');
    expect(recorded.path).toBe('/orders');
    expect(recorded.status).toBe(200);
    expect(recorded.spans.some((span) => span.kind === 'db')).toBe(true);
  });

  it('redacts bodies before recording', async () => {
    const { store, base } = await harness(platform);

    await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'ada', password: 'hunter2' }),
    });

    const recorded = await waitForRecord(store);
    expect(JSON.parse(recorded.requestBody?.text ?? '')).toEqual({
      login: 'ada',
      password: '[redacted]',
    });
    expect(JSON.parse(recorded.responseBody?.text ?? '')).toEqual({
      token: '[redacted]',
      user: 'ada',
    });
  });

  it('carries the exception to the record without changing the response', async () => {
    const { store, base } = await harness(platform);

    const response = await fetch(`${base}/boom`);
    expect(response.status).toBe(500);

    const recorded = await waitForRecord(store);
    expect(recorded.status).toBe(500);
    expect(recorded.error?.name).toBe('TypeError');
    expect(recorded.error?.message).toBe('handler crashed');
  });

  it('leaves error handling to the application’s own filter', async () => {
    // A catch-all filter from an imported module is picked over the
    // application's. Reqray used to register one, and adding the module
    // changed what clients were told on every error.
    const { store, base } = await harness(platform, [
      { provide: APP_FILTER, useClass: AppErrorFilter },
    ]);

    const response = await fetch(`${base}/boom`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ handledBy: 'the application' });

    // And the exception still reaches the record.
    expect((await waitForRecord(store)).error?.message).toBe('handler crashed');
  });

  it("a 404 from Nest's router is a regular record without an exception", async () => {
    const { store, base } = await harness(platform);

    const response = await fetch(`${base}/no-such-route`);
    expect(response.status).toBe(404);

    const recorded = await waitForRecord(store);
    expect(recorded.status).toBe(404);
    expect(recorded.error).toBeNull();
  });

  it('carries the N+1 finding through to the record', async () => {
    const { store, base } = await harness(platform);

    await fetch(`${base}/n-plus-one`);

    const recorded = await waitForRecord(store);
    const finding = recorded.findings.find((f) => f.detector === 'n_plus_one');
    expect(finding).toBeDefined();
    expect(finding?.callsite?.relative).toBe('src/orders.ts');
  });

  it('the panel responds and does not enter its own list', async () => {
    const { store, base } = await harness(platform);

    await fetch(`${base}/orders`);
    await waitForRecord(store);

    const panel = await fetch(`${base}/_reqray/api/requests`);
    expect(panel.status).toBe(200);
    const payload = (await panel.json()) as { requests: Array<{ path: string }> };
    expect(payload.requests).toHaveLength(1);
    expect(payload.requests[0]?.path).toBe('/orders');
  });
});

/**
 * `@loupe/nestjs` — NestJS adapter.
 *
 * One module in `imports`, nothing else. Underneath it defers to the existing
 * platform adapters: on Express (the Nest default) the `@loupe/express`
 * middleware goes through the middleware consumer, on Fastify the
 * `@loupe/fastify` plugin is registered on the underlying instance.
 *
 * The one thing neither platform adapter can see under Nest is the exception:
 * Nest intercepts it before Express error middleware or Fastify's `onError`
 * ever run. A global filter stamps it onto the request/response and then
 * defers to Nest's default handling, so behaviour does not change.
 *
 * Injection note: everything is an explicit `@Inject(token)` — this package
 * is built without decorator metadata emission.
 */

import { createRequire } from 'node:module';
import type { Loupe, LoupeInit } from '@loupe/core';
import { reportInstrumentation } from '@loupe/core';
import {
  recordFailure as expressFailure,
  loupe as expressLoupe,
  type LoupeExpress,
} from '@loupe/express';
import { recordFailure as fastifyFailure, loupe as fastifyLoupe } from '@loupe/fastify';
import {
  type ArgumentsHost,
  Catch,
  type DynamicModule,
  HttpException,
  Inject,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_FILTER, BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';

/** Token the Loupe options travel under inside the Nest container. */
export const LOUPE_OPTIONS = Symbol.for('loupe.nestjs.options');

function nestVersion(): string | undefined {
  try {
    const manifest = createRequire(import.meta.url)('@nestjs/core/package.json') as {
      version?: unknown;
    };
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The middleware wildcard changed with the Express 5 router: Nest 11 wants
 * `{*splat}` where Nest 10 wanted `*`.
 */
function allRoutes(): string {
  const version = nestVersion();
  const major = version ? Number.parseInt(version, 10) : 11;
  return major >= 11 ? '{*splat}' : '*';
}

/**
 * Global filter: records the exception, then hands it to Nest's default
 * handling unchanged.
 *
 * `HttpException` is Nest control flow (404, validation), not a crash — those
 * requests are recorded with their status anyway, like in every adapter.
 */
@Catch()
export class LoupeExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() === 'http' && !(exception instanceof HttpException)) {
      try {
        const http = host.switchToHttp();
        // One of the two matches the platform; the other is a safe no-op.
        expressFailure(http.getResponse(), exception);
        fastifyFailure(http.getRequest(), exception);
      } catch {
        // Recording must never interfere with error handling itself.
      }
    }
    super.catch(exception, host);
  }
}

/**
 * Loupe module for NestJS.
 *
 * @example
 * ```ts
 * @Module({
 *   imports: [LoupeModule.forRoot()],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class LoupeModule implements NestModule, OnModuleInit {
  static forRoot(options: LoupeInit = {}): DynamicModule {
    return {
      module: LoupeModule,
      providers: [
        { provide: LOUPE_OPTIONS, useValue: options },
        { provide: APP_FILTER, useClass: LoupeExceptionFilter },
      ],
    };
  }

  /** The Express inspector, when the platform is Express. */
  #express: LoupeExpress | null = null;

  readonly #adapterHost: HttpAdapterHost;
  readonly #options: LoupeInit;

  constructor(
    @Inject(HttpAdapterHost) adapterHost: HttpAdapterHost,
    @Inject(LOUPE_OPTIONS) options: LoupeInit,
  ) {
    this.#adapterHost = adapterHost;
    this.#options = options;
  }

  /** Runtime of the platform adapter — for tests and manual access. */
  get loupe(): Loupe | null {
    if (this.#express) return this.#express.runtime;
    if (this.#platform() === 'fastify') {
      const instance = this.#adapterHost.httpAdapter?.getInstance<FastifyInstance>();
      return (instance as FastifyInstance & { loupe?: Loupe })?.loupe ?? null;
    }
    return null;
  }

  #platform(): string {
    return this.#adapterHost.httpAdapter?.getType() ?? 'express';
  }

  configure(consumer: MiddlewareConsumer): void {
    if (this.#platform() !== 'express') return;

    reportInstrumentation({
      name: 'nestjs',
      version: nestVersion(),
      captures: 'requests (express platform)',
      ok: true,
    });

    this.#express = expressLoupe(this.#options);
    consumer.apply(this.#express.middleware).forRoutes(allRoutes());
  }

  async onModuleInit(): Promise<void> {
    if (this.#platform() !== 'fastify') return;

    reportInstrumentation({
      name: 'nestjs',
      version: nestVersion(),
      captures: 'requests (fastify platform)',
      ok: true,
    });

    const instance = this.#adapterHost.httpAdapter.getInstance<FastifyInstance>();
    await instance.register(fastifyLoupe, this.#options);
  }
}

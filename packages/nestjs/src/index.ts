/**
 * `@reqray/nestjs` — NestJS adapter.
 *
 * One module in `imports`, nothing else. Underneath it defers to the existing
 * platform adapters: on Express (the Nest default) the `@reqray/express`
 * middleware goes through the middleware consumer, on Fastify the
 * `@reqray/fastify` plugin is registered on the underlying instance.
 *
 * The one thing neither platform adapter can see under Nest is the exception:
 * Nest intercepts it before Express error middleware or Fastify's `onError`
 * ever run. A global interceptor stamps it onto the request/response as it
 * passes, and passes it on: handling stays with whichever filter the
 * application has, or with Nest's default.
 *
 * Injection note: everything is an explicit `@Inject(token)` — this package
 * is built without decorator metadata emission.
 */

import { createRequire } from 'node:module';
import {
  type CallHandler,
  type DynamicModule,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestInterceptor,
  type NestModule,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_INTERCEPTOR, HttpAdapterHost } from '@nestjs/core';
import type { Reqray, ReqrayInit } from '@reqray/core';
import { reportInstrumentation } from '@reqray/core';
import {
  recordFailure as expressFailure,
  reqray as expressReqray,
  type ReqrayExpress,
} from '@reqray/express';
import { recordFailure as fastifyFailure, reqray as fastifyReqray } from '@reqray/fastify';
import type { FastifyInstance } from 'fastify';
import { type Observable, tap } from 'rxjs';

/** Token the Reqray options travel under inside the Nest container. */
export const REQRAY_OPTIONS = Symbol.for('reqray.nestjs.options');

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
 * Global interceptor: records the exception on its way past, and does nothing
 * else with it.
 *
 * An observer rather than a filter. A catch-all filter registered by an
 * imported module is picked over the application's own, so the first version
 * of this — a filter deferring to Nest's default handling — replaced whatever
 * error responses the application had written with Nest's. An interceptor
 * never decides what the client is told.
 *
 * `HttpException` is Nest control flow (404, validation), not a crash — those
 * requests are recorded with their status anyway, like in every adapter. So
 * is an error thrown by a guard, which runs before any interceptor does.
 */
@Injectable()
export class ReqrayErrorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    return next.handle().pipe(
      tap({
        error: (exception: unknown) => {
          if (exception instanceof HttpException) return;
          try {
            const http = context.switchToHttp();
            // One of the two matches the platform; the other is a safe no-op.
            expressFailure(http.getResponse(), exception);
            fastifyFailure(http.getRequest(), exception);
          } catch {
            // Recording must never interfere with error handling itself.
          }
        },
      }),
    );
  }
}

/**
 * Reqray module for NestJS.
 *
 * @example
 * ```ts
 * @Module({
 *   imports: [ReqrayModule.forRoot()],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class ReqrayModule implements NestModule, OnModuleInit {
  static forRoot(options: ReqrayInit = {}): DynamicModule {
    return {
      module: ReqrayModule,
      providers: [
        { provide: REQRAY_OPTIONS, useValue: options },
        { provide: APP_INTERCEPTOR, useClass: ReqrayErrorInterceptor },
      ],
    };
  }

  /** The Express inspector, when the platform is Express. */
  #express: ReqrayExpress | null = null;

  readonly #adapterHost: HttpAdapterHost;
  readonly #options: ReqrayInit;

  constructor(
    @Inject(HttpAdapterHost) adapterHost: HttpAdapterHost,
    @Inject(REQRAY_OPTIONS) options: ReqrayInit,
  ) {
    this.#adapterHost = adapterHost;
    this.#options = options;
  }

  /** Runtime of the platform adapter — for tests and manual access. */
  get reqray(): Reqray | null {
    if (this.#express) return this.#express.runtime;
    if (this.#platform() === 'fastify') {
      const instance = this.#adapterHost.httpAdapter?.getInstance<FastifyInstance>();
      return (instance as FastifyInstance & { reqray?: Reqray })?.reqray ?? null;
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

    this.#express = expressReqray(this.#options);
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
    await instance.register(fastifyReqray, this.#options);
  }
}

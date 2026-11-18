/**
 * A double of the `ioredis` module reproducing the part the instrumentation
 * touches: `sendCommand`, and the command object it is handed.
 *
 * It exists to check the thing that matters most — the transparency of the
 * wrapper — without a server: what a reply looks like coming back, what an
 * error looks like, what happens to a command that passes through twice. A
 * real Redis is covered separately, by the testcontainers test.
 *
 * The module shape is the awkward one ioredis really has: the export is the
 * `Redis` class itself, and also a namespace holding `Redis`, `default` and
 * `Cluster` — the same prototype reachable by several paths.
 */

/** What the fake "executes". May throw — that is a scenario too. */
export type FakeRunner = (command: string, args: readonly unknown[]) => unknown;

/** The ioredis command object: a name, arguments, and a settled promise. */
export class FakeCommand {
  readonly name: string;
  readonly args: unknown[];
  readonly promise: Promise<unknown>;
  resolve!: (reply: unknown) => void;
  reject!: (error: unknown) => void;

  constructor(name: string, args: unknown[]) {
    this.name = name;
    this.args = args;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export interface FakeRedis {
  sendCommand(command: FakeCommand): Promise<unknown>;
  call(name: string, ...args: unknown[]): Promise<unknown>;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
  hget(key: string, field: string): Promise<unknown>;
}

export interface FakeIoredis {
  new (): FakeRedis;
  Redis: FakeIoredis;
  default: FakeIoredis;
  Cluster: { new (): FakeRedis };
  /** Every command that reached the driver. */
  readonly calls: Array<{ name: string; args: readonly unknown[] }>;
}

const defaultRunner: FakeRunner = () => 'OK';

/**
 * Each call produces a new module double, so patching one never leaks into
 * another test.
 */
export function createFakeIoredis(runner: FakeRunner = defaultRunner): FakeIoredis {
  const calls: Array<{ name: string; args: readonly unknown[] }> = [];

  // Redis and Cluster are separate classes with separate prototypes, as they
  // are in ioredis: patching one must not be mistaken for patching the other.
  const clientClass = () =>
    class Client implements FakeRedis {
      sendCommand(command: FakeCommand): Promise<unknown> {
        calls.push({ name: command.name, args: command.args });
        // The reply always lands a tick later, as it would off a socket.
        queueMicrotask(() => {
          try {
            command.resolve(runner(command.name, command.args));
          } catch (error) {
            command.reject(error);
          }
        });
        return command.promise;
      }

      call(name: string, ...args: unknown[]): Promise<unknown> {
        return this.sendCommand(new FakeCommand(name, args));
      }

      get(key: string): Promise<unknown> {
        return this.call('get', key);
      }

      set(key: string, value: unknown): Promise<unknown> {
        return this.call('set', key, value);
      }

      hget(key: string, field: string): Promise<unknown> {
        return this.call('hget', key, field);
      }
    };

  const module = clientClass() as unknown as FakeIoredis;
  module.Redis = module;
  module.default = module;
  module.Cluster = clientClass();
  Object.defineProperty(module, 'calls', { value: calls });
  return module;
}

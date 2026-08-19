/**
 * A double of the `pg` module reproducing the `Client.prototype.query`
 * contract.
 *
 * It exists to check the thing that matters most — the transparency of the
 * wrapper — without a database: both call styles, every argument shape, the
 * order and type of errors. Real Postgres is covered separately, by the
 * testcontainers test.
 */

export interface FakeResult {
  readonly rows: unknown[];
  readonly rowCount: number;
}

/** What the fake driver "executes". May throw — that is a scenario too. */
export type FakeRunner = (sql: string, values: unknown[] | undefined) => FakeResult;

export interface FakePg {
  Client: new () => FakeClient;
  /** Every `query` call that reached the driver. */
  readonly calls: Array<{ sql: string; values: unknown[] | undefined }>;
}

export interface FakeClient {
  query(...args: any[]): any;
}

const defaultRunner: FakeRunner = () => ({ rows: [{ id: 1 }], rowCount: 1 });

/**
 * Each call produces a new `Client` class, so patching one double never leaks
 * into another test.
 */
export function createFakePg(runner: FakeRunner = defaultRunner): FakePg {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];

  class Client implements FakeClient {
    query(...args: any[]): any {
      const first = args[0];
      const sql = typeof first === 'string' ? first : first?.text;

      const last = args[args.length - 1];
      const callback = typeof last === 'function' ? last : undefined;
      const values = Array.isArray(args[1]) ? (args[1] as unknown[]) : undefined;

      calls.push({ sql, values });

      const execute = (): FakeResult => runner(sql, values);

      if (callback) {
        // pg invokes the callback asynchronously and returns undefined.
        queueMicrotask(() => {
          try {
            callback(null, execute());
          } catch (error) {
            callback(error, undefined);
          }
        });
        return undefined;
      }

      return new Promise<FakeResult>((resolve, reject) => {
        queueMicrotask(() => {
          try {
            resolve(execute());
          } catch (error) {
            reject(error);
          }
        });
      });
    }
  }

  return { Client, calls };
}

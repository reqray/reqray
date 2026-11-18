/**
 * Cache for the demo.
 *
 * Defaults to a Redis-compatible server running inside this process, so
 * `pnpm start` needs no Docker and no local Redis. It speaks RESP over a
 * socket, so the app connects with the ordinary `ioredis` driver and Reqray
 * instruments it exactly as it would a real server — the point of the demo is
 * the driver, not the database behind it.
 *
 * Set `REDIS_URL` to point at a real Redis instead.
 */

import { createServer } from 'node:net';
import Redis from 'ioredis';

const CRLF = '\r\n';

/** A RESP simple string — `+OK`, as opposed to a bulk string. */
class Simple {
  constructor(text) {
    this.text = text;
  }
}

function encode(value) {
  if (value === null || value === undefined) return Buffer.from(`$-1${CRLF}`);
  if (value instanceof Simple) return Buffer.from(`+${value.text}${CRLF}`);
  if (value instanceof Error) return Buffer.from(`-${value.message}${CRLF}`);
  if (typeof value === 'number') return Buffer.from(`:${value}${CRLF}`);
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from(`*${value.length}${CRLF}`), ...value.map(encode)]);
  }
  const bytes = Buffer.from(String(value));
  return Buffer.concat([Buffer.from(`$${bytes.length}${CRLF}`), bytes, Buffer.from(CRLF)]);
}

/**
 * Pulls whole commands off the incoming buffer.
 *
 * Clients send commands as arrays of bulk strings and nothing else, so that is
 * all this understands. Returns the commands it could complete and whatever
 * bytes are left over for the next chunk.
 */
function parse(buffer) {
  const commands = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer[offset] !== 0x2a /* * */) return { commands, rest: Buffer.alloc(0) };

    const headerEnd = buffer.indexOf(CRLF, offset);
    if (headerEnd === -1) return { commands, rest: buffer.subarray(start) };

    const count = Number(buffer.subarray(offset + 1, headerEnd));
    offset = headerEnd + 2;

    const args = [];
    let incomplete = false;
    for (let index = 0; index < count; index++) {
      const lengthEnd = buffer.indexOf(CRLF, offset);
      if (lengthEnd === -1) {
        incomplete = true;
        break;
      }
      const length = Number(buffer.subarray(offset + 1, lengthEnd));
      const valueStart = lengthEnd + 2;
      if (buffer.length < valueStart + length + 2) {
        incomplete = true;
        break;
      }
      args.push(buffer.subarray(valueStart, valueStart + length).toString());
      offset = valueStart + length + 2;
    }

    if (incomplete) return { commands, rest: buffer.subarray(start) };
    commands.push(args);
  }

  return { commands, rest: Buffer.alloc(0) };
}

/** Just enough of Redis for the demo's routes. Everything else answers `OK`. */
function createStore() {
  const values = new Map();
  const expiries = new Map();

  const live = (key) => {
    const expiresAt = expiries.get(key);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      values.delete(key);
      expiries.delete(key);
      return false;
    }
    return values.has(key);
  };

  const hash = (key) => {
    const existing = live(key) ? values.get(key) : undefined;
    return existing instanceof Map ? existing : new Map();
  };

  return (name, args) => {
    switch (name) {
      case 'GET':
        return live(args[0]) ? values.get(args[0]) : null;
      case 'MGET':
        return args.map((key) => (live(key) ? values.get(key) : null));
      case 'SET': {
        values.set(args[0], args[1]);
        expiries.delete(args[0]);
        const ttlIndex = args.findIndex((argument) => argument.toUpperCase() === 'EX');
        if (ttlIndex !== -1) expiries.set(args[0], Date.now() + Number(args[ttlIndex + 1]) * 1000);
        return new Simple('OK');
      }
      case 'SETEX':
        values.set(args[0], args[2]);
        expiries.set(args[0], Date.now() + Number(args[1]) * 1000);
        return new Simple('OK');
      case 'DEL':
      case 'UNLINK': {
        let removed = 0;
        for (const key of args) {
          if (live(key)) removed++;
          values.delete(key);
          expiries.delete(key);
        }
        return removed;
      }
      case 'EXISTS':
        return args.filter((key) => live(key)).length;
      case 'TTL': {
        if (!live(args[0])) return -2;
        const expiresAt = expiries.get(args[0]);
        return expiresAt === undefined ? -1 : Math.ceil((expiresAt - Date.now()) / 1000);
      }
      case 'INCR': {
        const next = Number(live(args[0]) ? values.get(args[0]) : 0) + 1;
        values.set(args[0], String(next));
        return next;
      }
      case 'HSET': {
        const fields = hash(args[0]);
        for (let index = 1; index < args.length; index += 2)
          fields.set(args[index], args[index + 1]);
        values.set(args[0], fields);
        return fields.size;
      }
      case 'HGET':
        return hash(args[0]).get(args[1]) ?? null;
      case 'HGETALL':
        return [...hash(args[0])].flat();
      case 'FLUSHALL':
        values.clear();
        expiries.clear();
        return new Simple('OK');
      case 'PING':
        return new Simple('PONG');
      case 'INFO':
        // ioredis reads this on connect and refuses to go ready without it.
        return 'redis_version:7.4.0\r\nloading:0\r\n';
      default:
        return new Simple('OK');
    }
  };
}

async function startEmbedded() {
  const execute = createStore();

  const server = createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const { commands, rest } = parse(pending);
      pending = rest;
      for (const [name, ...args] of commands) {
        socket.write(encode(execute(String(name).toUpperCase(), args)));
      }
    });
    socket.on('error', () => socket.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    url: `redis://127.0.0.1:${server.address().port}`,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Starts the cache and returns a connected client plus a shutdown hook. */
export async function connectCache() {
  const embedded = process.env.REDIS_URL ? null : await startEmbedded();
  const client = new Redis(process.env.REDIS_URL ?? embedded.url);

  return {
    client,
    embedded: embedded !== null,
    async stop() {
      // `quit` waits for the reply; a demo that is being killed should not.
      client.disconnect();
      await embedded?.stop();
    },
  };
}

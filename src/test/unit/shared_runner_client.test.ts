import net from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectSharedRunner, type SharedConnectOptions } from '../../local_engine/stdio_runner';

/** Speaks the shared-runner server protocol: auth gate, ready, token streaming. */
class FakeSharedRunner {
  readonly server = net.createServer();
  port = 0;
  private connections: net.Socket[] = [];

  constructor(private readonly token = 's3cret') {}

  async listen(): Promise<number> {
    return await new Promise((resolve) => {
      this.server.on('error', () => undefined);
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address() as net.AddressInfo;
        this.port = address.port;
        resolve(this.port);
      });
    });
  }

  serve(): void {
    this.server.on('connection', (socket) => {
      socket.on('error', () => undefined);
      this.connections.push(socket);
      let authenticated = false;
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (let nl; (nl = buffer.indexOf('\n')) !== -1; buffer = buffer.slice(nl + 1)) {
          const line = buffer.slice(0, nl);
          const message = JSON.parse(line) as Record<string, unknown>;
          if (!authenticated) {
            if (message.type !== 'auth' || message.token !== this.token) {
              socket.write(JSON.stringify({ type: 'error', id: null, message: 'auth required' }) + '\n');
              socket.destroy();
              return;
            }
            authenticated = true;
            socket.write(JSON.stringify({ type: 'ready', model: '/m', device: 'CPU', pid: 1, port: this.port }) + '\n');
            continue;
          }
          if (message.type === 'generate') {
            const id = message.id;
            socket.write(JSON.stringify({ type: 'token', id, text: 'a' }) + '\n');
            socket.write(JSON.stringify({ type: 'token', id, text: 'b' }) + '\n');
            socket.write(JSON.stringify({ type: 'done', id, finishReason: 'stop' }) + '\n');
          }
        }
      });
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const s of this.connections) {
      s.end();
    }
    this.server.close();
  }

  private closed = false;
}

describe('connectSharedRunner', () => {
  let runner: FakeSharedRunner;
  const open: FakeSharedRunner[] = [];

  const connect = async (overrides: Partial<SharedConnectOptions> = {}) =>
    await connectSharedRunner(
      {
        transport: 'tcp',
        port: runner.port,
        token: 's3cret',
        modelPath: '/m',
        readyTimeoutMs: 2000,
        ...overrides,
      },
    );

  beforeEach(async () => {
    runner = new FakeSharedRunner();
    await runner.listen();
    runner.serve();
  });
  afterEach(() => {
    for (const r of open) {
      r.close();
    }
    runner.close();
  });

  it('authenticates, verifies the ready handshake and streams its own tokens', async () => {
    const client = await connect();
    const tokens: string[] = [];
    for await (const t of client.stream('p', 8, [])) {
      tokens.push(t);
    }
    expect(tokens).toEqual(['a', 'b']);
    await client.stop();
  });

  it('a wrong token is rejected with the auth error', async () => {
    await expect(connect({ token: 'wrong' })).rejects.toThrow(/auth required/);
  });

  it('a ready handshake with a different model is rejected', async () => {
    await expect(connect({ modelPath: '/other' })).rejects.toThrow(/model mismatch/);
  });

  it('losing the connection surfaces through onUnexpectedExit', async () => {
    const exits: string[] = [];
    const client = await connect({ onUnexpectedExit: (m) => exits.push(m) });
    const pending = client.stream('p', 8, []).next();
    runner.close();
    await expect(pending).rejects.toThrow();
    expect(exits).toHaveLength(1);
    open.push(runner);
  });
});

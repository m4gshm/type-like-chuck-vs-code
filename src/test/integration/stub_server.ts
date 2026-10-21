import * as http from 'node:http';

export interface StubServerOptions {
  /** Response status code. */
  status?: number;
  /** Generated text chunks streamed as SSE. */
  chunks?: string[];
  /** Delay before responding, in milliseconds. */
  delayMs?: number;
}

export interface StubServer {
  url: string;
  requestCount(): number;
  lastBody(): { prompt?: string; stop?: string[] } | undefined;
  close(): Promise<void>;
}

/**
 * Minimal OpenAI-compatible stub for the legacy /v1/completions endpoint.
 * Streams `chunks` as an SSE completion response.
 */
export async function startStubServer(options: StubServerOptions = {}): Promise<StubServer> {
  const { status = 200, chunks = ['hello'], delayMs = 0 } = options;
  let requestCount = 0;
  let lastBody: { prompt?: string; stop?: string[] } | undefined;

  const server = http.createServer((req, res) => {
    res.on('close', () => server.emit('request-complete'));
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requestCount += 1;
      try {
        lastBody = body ? JSON.parse(body) : undefined;
      } catch {
        lastBody = undefined;
      }

      const respond = () => {
        if (status !== 200) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'stub error', type: 'invalid_request_error' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of chunks) {
          res.write(`data: ${JSON.stringify({ id: 'stub', object: 'completion', choices: [{ text: chunk }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      };

      if (delayMs > 0) {
        setTimeout(respond, delayMs);
      } else {
        respond();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requestCount: () => requestCount,
    lastBody: () => lastBody,
    close: () =>
      new Promise((resolve, reject) => {
        // Keep-alive sockets (e.g. from the SDK's model listing) would keep
        // close() waiting forever; drop them explicitly.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

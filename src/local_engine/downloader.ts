import { createWriteStream } from 'fs';
import { rename, rm } from 'fs/promises';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';

type ProxyAgentInstance = InstanceType<typeof HttpsProxyAgent>;

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number | undefined;
  /** Set when a model consists of several files downloaded in sequence. */
  fileName?: string;
  fileIndex?: number;
  fileCount?: number;
}

export interface DownloadOptions {
  url: string;
  destination: string;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export function proxyUrlFromEnv(): string | undefined {
  return process.env.HTTPS_PROXY
    ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY
    ?? process.env.http_proxy;
}

interface SimpleResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  stream: Readable;
}

function nodeRequest(url: URL, agent: ProxyAgentInstance | undefined, signal: AbortSignal | undefined, proxy?: URL): Promise<SimpleResponse> {
  const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
  // Plain-http targets go through the proxy in absolute-form; https ones use
  // the CONNECT-tunneling agent.
  const requestUrl = proxy !== undefined && url.protocol === 'http:' ? url.href : url;
  // The agent instance comes from a CJS dependency whose Agent type resolves
  // through a different agent-base copy than Node's typings expect.
  const options = { agent: agent as never, signal };
  return new Promise((resolve, reject) => {
    const req = doRequest(requestUrl, options);
    req.on('error', reject);
    req.on('response', (res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res });
    });
    req.end();
  });
}

const REDIRECT_LIMIT = 5;

// A dropped connection surfaces as Node's bare "aborted" — wrap it with context.
function downloadError(err: unknown, url: string, signal: AbortSignal | undefined, downloaded?: number): Error {
  if (signal?.aborted) {
    return new DOMException('Download canceled', 'AbortError');
  }
  const bytes = downloaded === undefined ? '' : ` after ${downloaded} bytes`;
  return new Error(`Download failed${bytes}: ${err instanceof Error ? err.message : String(err)} (${url})`);
}

async function requestFollowingRedirects(url: URL, agent: ProxyAgentInstance | undefined, signal: AbortSignal | undefined, proxy?: URL): Promise<SimpleResponse> {
  let current = url;
  for (let redirects = 0; ; redirects += 1) {
    const response = await nodeRequest(current, agent, signal, proxy);
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && typeof location === 'string' && redirects < REDIRECT_LIMIT) {
      response.stream.resume();
      current = new URL(location, current);
      continue;
    }
    return response;
  }
}

/**
 * Fetches the URL honoring the standard HTTPS_PROXY / HTTP_PROXY environment
 * variables (Node's global fetch ignores them) and returns a web stream.
 */
async function defaultRequest(url: string, signal?: AbortSignal): Promise<{ status: number; headers: Headers; body: Readable }> {
  const proxy = proxyUrlFromEnv();
  const proxyUrl = proxy !== undefined ? new URL(proxy) : undefined;
  const agent = proxyUrl !== undefined && new URL(url).protocol === 'https:' ? new HttpsProxyAgent(proxyUrl.href) : undefined;  const response = await requestFollowingRedirects(new URL(url), agent, signal, proxyUrl);
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value);
    }
  }
  return { status: response.status, headers, body: response.stream };
}

/**
 * Streams the URL into `<destination>.part` and renames it into place on
 * success; a canceled or failed download leaves no destination file and the
 * `.part` file is removed.
 */
export async function downloadFile({ url, destination, onProgress, signal, fetchImpl }: DownloadOptions): Promise<void> {
  let totalBytes: number | undefined;
  let source: Readable;
  if (fetchImpl !== undefined) {
    let response: Awaited<ReturnType<typeof fetchImpl>>;
    try {
      response = await fetchImpl(url, { signal });
    } catch (err) {
      throw downloadError(err, url, signal);
    }
    if (!response.ok || response.body === null) {
      throw new Error(`Download failed (${response.status}): ${url}`);
    }
    const totalHeader = response.headers.get('content-length');
    totalBytes = totalHeader !== null && Number.isFinite(+totalHeader) ? Number(totalHeader) : undefined;
    source = Readable.fromWeb(response.body as import('stream/web').ReadableStream);
  } else {
    let response: Awaited<ReturnType<typeof defaultRequest>>;
    try {
      response = await defaultRequest(url, signal);
    } catch (err) {
      throw downloadError(err, url, signal);
    }
    if (response.status !== 200) {
      throw new Error(`Download failed (${response.status}): ${url}`);
    }
    const totalHeader = response.headers.get('content-length');
    totalBytes = totalHeader !== null && Number.isFinite(+totalHeader) ? Number(totalHeader) : undefined;
    source = response.body;
  }
  const partFile = `${destination}.part`;
  let downloaded = 0;
  source.on('data', (chunk: Buffer) => {
    downloaded += chunk.length;
    onProgress?.({ downloadedBytes: downloaded, totalBytes });
  });
  try {
    await pipeline(source, createWriteStream(partFile));
  } catch (err) {
    await rm(partFile, { force: true });
    throw downloadError(err, url, signal, downloaded);
  }
  await rename(partFile, destination);
}

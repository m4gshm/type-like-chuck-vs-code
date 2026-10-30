#!/usr/bin/env node
// Imports the runner binaries built by the backend repositories
// (m4gshm/type-like-chuck-backed-openvino, m4gshm/type-like-chuck-backed-mlx)
// into binaries/<engine>/<platform>/ with the final names the extension
// resolves at runtime, restoring the executable bit lost in release assets.
//
// Backend version: pin with RUNNER_VERSION=<tag> (e.g. v0.1.0), otherwise each
// backend repo's latest GitHub release is used. Runners already present on
// disk are not re-downloaded.
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { chmod, rename } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';

const OWNER = 'm4gshm';
const TARGETS = [
  { repo: 'type-like-chuck-backed-openvino', dir: 'binaries/ovgenai/win32-x64', asset: 'tlc-ovgenai-runner-win32-x64.exe', finalName: 'tlc-ovgenai-runner.exe' },
  { repo: 'type-like-chuck-backed-openvino', dir: 'binaries/ovgenai/linux-x64', asset: 'tlc-ovgenai-runner-linux-x64', finalName: 'tlc-ovgenai-runner' },
  { repo: 'type-like-chuck-backed-mlx', dir: 'binaries/mlx/darwin-arm64', asset: 'tlc-mlx-runner-macos-arm64', finalName: 'tlc-mlx-runner' },
];

const githubToken = process.env.GITHUB_TOKEN;
const headers = githubToken !== undefined ? { Authorization: `Bearer ${githubToken}` } : {};
const version = process.env.RUNNER_VERSION;

async function download(url, destination) {
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  const part = `${destination}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
  await rename(part, destination);
}

async function releaseAssets(repo) {
  const endpoint = version !== undefined && version.length > 0
    ? `https://api.github.com/repos/${OWNER}/${repo}/releases/tags/${version}`
    : `https://api.github.com/repos/${OWNER}/${repo}/releases/latest`;
  const release = await (await fetch(endpoint, { headers })).json();
  if (release.message !== undefined) {
    throw new Error(`Backend release lookup failed (${release.message})${version ? ` for tag ${version}` : ''}.`);
  }
  return release.assets ?? [];
}

const assetsByRepo = new Map();
for (const target of TARGETS) {
  const destination = join(target.dir, target.finalName);
  if (existsSync(destination)) {
    console.log(`runner binary present: ${destination}`);
    continue;
  }
  mkdirSync(target.dir, { recursive: true });
  if (!assetsByRepo.has(target.repo)) {
    assetsByRepo.set(target.repo, await releaseAssets(target.repo));
  }
  const assets = assetsByRepo.get(target.repo);
  const asset = assets.find((a) => a.name === target.asset);
  if (asset === undefined) {
    console.error(`Missing runner binary: ${target.asset} (not found among ${OWNER}/${target.repo} release assets).`);
    process.exit(1);
  }
  console.log(`fetching ${target.asset} from ${OWNER}/${target.repo} release…`);
  await download(asset.browser_download_url, destination);
  if (process.platform !== 'win32') {
    await chmod(destination, 0o755);
  }
  console.log(`fetched ${destination}`);
}

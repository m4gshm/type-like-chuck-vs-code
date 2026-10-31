#!/usr/bin/env node
// Imports the runner binaries built by the backend repositories
// (m4gshm/type-like-chuck-backed-openvino, m4gshm/type-like-chuck-backed-mlx)
// into binaries/<engine>/<platform>/ with the final names the extension
// resolves at runtime, restoring the executable bit lost in release assets.
//
// Backend version: pin with RUNNER_VERSION=<tag> (e.g. v0.1.0), otherwise each
// backend repo's latest GitHub release is used. Runners already present on
// disk are not re-downloaded.
import { existsSync, mkdirSync, createWriteStream, copyFileSync } from 'node:fs';
import { chmod, rename } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OWNER = 'm4gshm';
const TARGETS = [
  // hostPlatform: the runner binary built by `task build` in the sibling backend repo
  // (build/<asset>) matches this target only on the host platform.
  { repo: 'type-like-chuck-backed-openvino', dir: 'binaries/ovgenai/win32-x64', asset: 'tlc-ovgenai-runner-win32-x64.exe', finalName: 'tlc-ovgenai-runner.exe', hostPlatform: 'win32' },
  { repo: 'type-like-chuck-backed-openvino', dir: 'binaries/ovgenai/linux-x64', asset: 'tlc-ovgenai-runner-linux-x64', finalName: 'tlc-ovgenai-runner', hostPlatform: 'linux' },
  { repo: 'type-like-chuck-backed-mlx', dir: 'binaries/mlx/darwin-arm64', asset: 'tlc-mlx-runner-macos-arm64', finalName: 'tlc-mlx-runner', hostPlatform: 'darwin' },
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

// Sibling backend repo directory: <ext-root>/../<repo> (the repo holding the
// Taskfile that builds build/<asset> for the host OS).
const localRepoDir = (repo) => join(dirname(fileURLToPath(import.meta.url)), '..', '..', repo);

// Local build fallback: if the sibling backend repo exists for this host
// platform, copy (or first build via `task build`) the freshly built runner.
// This avoids needing a GitHub release for local builds and F5 runs.
// Skipped when RUNNER_VERSION pins a release.
function localBuild(target) {
  if (version !== undefined && version.length > 0) {
    return undefined;
  }
  const repoDir = localRepoDir(target.repo);
  if (target.hostPlatform !== process.platform || !existsSync(repoDir)) {
    return undefined;
  }
  const localBinary = join(repoDir, 'build', target.asset);
  if (!existsSync(localBinary)) {
    console.log(`building ${target.repo} via task build…`);
    const result = spawnSync('task', ['build'], { cwd: repoDir, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status !== 0 || !existsSync(localBinary)) {
      throw new Error(`task build failed in ${repoDir} (exit ${result.status ?? 'spawn error'}) — see output above; build the runner there or set RUNNER_VERSION to a published release.`);
    }
  }
  console.log(`using local build: ${localBinary}`);
  return localBinary;
}

const assetsByRepo = new Map();
for (const target of TARGETS) {
  const destination = join(target.dir, target.finalName);
  if (existsSync(destination)) {
    console.log(`runner binary present: ${destination}`);
    continue;
  }
  mkdirSync(target.dir, { recursive: true });
  const localBinary = localBuild(target);
  if (localBinary !== undefined) {
    copyFileSync(localBinary, destination);
    if (process.platform !== 'win32') {
      await chmod(destination, 0o755);
    }
    console.log(`copied ${destination}`);
    continue;
  }
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

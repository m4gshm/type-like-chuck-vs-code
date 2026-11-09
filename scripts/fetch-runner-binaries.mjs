#!/usr/bin/env node
// Imports the runner binaries built by the backend repositories
// (m4gshm/type-like-chuck-backed-openvino, m4gshm/type-like-chuck-backed-mlx)
// into binaries/<engine>/<platform>/ with the final names the extension
// resolves at runtime, restoring the executable bit lost in release assets.
//
// --release: download-only mode for the F5 "release" launch configuration —
// fetches the pinned release into binaries/ovgenai-release/<platform>/ and
// never falls back to a local build.
//
// Backend version: pinned per repo below so a plugin build always pairs with
// a runner release it was developed against (compatibility over freshness).
// Override with RUNNER_VERSION=<tag> to fetch that tag from every backend;
// a pin (the defaults above or the override) also disables the local-build
// fallback: a plugin build always pairs with the published runner release.
// A downloaded
// runner records its release in a <binary>.tag sidecar: it is re-downloaded
// only when that version differs from the expected one.
import { existsSync, mkdirSync, createWriteStream, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { chmod, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OWNER = 'm4gshm';
const releaseOnly = process.argv.includes('--release');
const TARGETS = [
  // hostPlatform: the runner binary built by `task build` in the sibling backend repo
  // (build/<asset>) matches this target only on the host platform.
  { repo: 'type-like-chuck-backed-openvino', dir: 'binaries/ovgenai/win32-x64', releaseDir: 'binaries/ovgenai-release/win32-x64', asset: 'tlc-ovgenai-runner-win32-x64.exe', finalName: 'tlc-ovgenai-runner.exe', hostPlatform: 'win32' },
  { repo: 'type-like-chuck-backed-openvino', dir: 'binaries/ovgenai/linux-x64', releaseDir: 'binaries/ovgenai-release/linux-x64', asset: 'tlc-ovgenai-runner-linux-x64', finalName: 'tlc-ovgenai-runner', hostPlatform: 'linux' },
  { repo: 'type-like-chuck-backed-openvino', dir: 'binaries/ovgenai/linux-arm64', releaseDir: 'binaries/ovgenai-release/linux-arm64', asset: 'tlc-ovgenai-runner-linux-arm64', finalName: 'tlc-ovgenai-runner' },
  { repo: 'type-like-chuck-backed-mlx', dir: 'binaries/mlx/darwin-arm64', asset: 'tlc-mlx-runner-macos-arm64.tar.gz', finalName: 'tlc-mlx-runner', hostPlatform: 'darwin', bundlesFrom: '.build/release' },
];

const githubToken = process.env.GITHUB_TOKEN;
const headers = githubToken !== undefined ? { Authorization: `Bearer ${githubToken}` } : {};
const versionOverride = process.env.RUNNER_VERSION?.trim() || undefined;
const DEFAULT_RUNNER_VERSIONS = {
  'type-like-chuck-backed-openvino': 'v0.1.0',
  'type-like-chuck-backed-mlx': 'v0.1.0',
};
const version = (repo) => versionOverride ?? DEFAULT_RUNNER_VERSIONS[repo];

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
  const tag = version(repo);
  const endpoint = tag !== undefined
    ? `https://api.github.com/repos/${OWNER}/${repo}/releases/tags/${tag}`
    : `https://api.github.com/repos/${OWNER}/${repo}/releases/latest`;
  const release = await (await fetch(endpoint, { headers })).json();
  if (release.message !== undefined) {
    throw new Error(`Backend release lookup failed (${release.message})${tag ? ` for tag ${tag}` : ''}.`);
  }
  return release.assets ?? [];
}

// Backend submodule directory: <ext-root>/<repo> (the repo holding the
// Taskfile that builds build/<asset> for the host OS).
const localRepoDir = (repo) => join(dirname(fileURLToPath(import.meta.url)), '..', repo);

// Local build fallback: if the sibling backend repo exists for this host
// platform, copy (or first build via `task build`) the freshly built runner.
// This avoids needing a GitHub release when no release is pinned (local
// backend development). Skipped whenever a version is pinned — CI has no
// `task` and a pinned build must pair with the published release anyway.
function localBuild(target) {
  if (version(target.repo) !== undefined || releaseOnly) {
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

// SwiftPM puts target resources (MLX default metallib) into <pkg>_<target>.bundle
// next to the binary in .build/release; without them the runner fails to load Metal.
async function copyResourceBundles(target, destinationDir) {
  if (target.bundlesFrom === undefined) {
    return;
  }
  const resourcesDir = join(localRepoDir(target.repo), target.bundlesFrom);
  if (!existsSync(resourcesDir)) {
    return;
  }
  const { cpSync, readdirSync } = await import('node:fs');
  for (const entry of readdirSync(resourcesDir)) {
    if (entry.endsWith('.bundle')) {
      cpSync(join(resourcesDir, entry), join(destinationDir, entry), { recursive: true });
      console.log(`copied ${entry} -> ${destinationDir}`);
    }
  }
}

const assetsByRepo = new Map();
// A recorded release tag means the binary came from a GitHub release; 'local'
// or no tag means a local build (packaging keeps it, --release always wants
// the pinned release).
function onDiskTag(destination) {
  const tagPath = `${destination}.tag`;
  return existsSync(tagPath) ? readFileSync(tagPath, 'utf8').trim() : '';
}
const writeTag = (destination, tag) => writeFileSync(`${destination}.tag`, `${tag}\n`);

for (const target of TARGETS) {
  const dir = releaseOnly && target.releaseDir !== undefined ? target.releaseDir : target.dir;
  const destination = join(dir, target.finalName);
  const expected = version(target.repo);
  if (existsSync(destination)) {
    const diskTag = onDiskTag(destination);
    const acceptable = expected === undefined ? diskTag === 'local' || diskTag === '' : diskTag === expected;
    if (acceptable) {
      console.log(`runner binary present: ${destination}`);
      continue;
    }
    console.log(`runner binary on disk is ${diskTag === '' ? 'untagged' : diskTag}, expected ${expected} — re-downloading`);
  }
  mkdirSync(dir, { recursive: true });
  const localBinary = localBuild(target);
  if (localBinary !== undefined) {
    // Replacing in place can leave macOS with a stale-mapped binary it then
    // SIGKILLs on exec; remove first.
    rmSync(destination, { force: true });
    copyFileSync(localBinary, destination);
    if (process.platform !== 'win32') {
      await chmod(destination, 0o755);
    }
    await copyResourceBundles(target, dirname(destination));
    writeTag(destination, 'local');
    console.log(`copied ${destination}`);
    continue;
  }
  if (!assetsByRepo.has(target.repo)) {
    try {
      assetsByRepo.set(target.repo, await releaseAssets(target.repo));
    } catch (err) {
      // A repo without a pin may simply not be published yet; skip it
      // instead of failing the whole package run. A pinned lookup
      // failure is fatal: the pinned release must exist.
      if (version(target.repo) === undefined) {
        console.warn(`skipping ${OWNER}/${target.repo}: ${err.message}`);
        assetsByRepo.set(target.repo, null);
      } else {
        throw err;
      }
    }
  }
  const assets = assetsByRepo.get(target.repo);
  if (assets === null) {
    continue;
  }
  const asset = assets.find((a) => a.name === target.asset);
  if (asset === undefined) {
    console.error(`Missing runner binary: ${target.asset} (not found among ${OWNER}/${target.repo} release assets).`);
    process.exit(1);
  }
  console.log(`fetching ${target.asset} from ${OWNER}/${target.repo} release ${expected ?? 'latest'}…`);
  if (target.asset.endsWith('.tar.gz')) {
    // The archive carries the binary plus the SwiftPM resource bundles
    // (metallib); tar preserves the executable bit on extraction.
    await download(asset.browser_download_url, `${destination}.tar.gz`);
    const extract = spawnSync('tar', ['-xzf', `${destination}.tar.gz`, '-C', dir], { stdio: 'inherit' });
    if (extract.status !== 0) {
      process.exit(extract.status ?? 1);
    }
    // The archive names the binary after the asset (tlc-mlx-runner-macos-arm64);
    // the extension resolves finalName — align the extracted name.
    const extracted = join(dir, target.asset.replace(/\.tar\.gz$/, ''));
    if (!existsSync(destination) && existsSync(extracted)) {
      rmSync(destination, { force: true });
      await rename(extracted, destination);
    }
    await chmod(destination, 0o755);
    await rm(`${destination}.tar.gz`, { force: true });
  } else {
    await download(asset.browser_download_url, destination);
    if (process.platform !== 'win32') {
      await chmod(destination, 0o755);
    }
  }
  writeTag(destination, expected ?? 'latest');
  console.log(`fetched ${destination}`);
}

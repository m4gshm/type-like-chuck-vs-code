#!/usr/bin/env node
// Puts the backend runner binary into binaries/<engine>/<platform>/ under the
// name the extension resolves at runtime. Reuses a binary already on disk
// (downloaded from the pinned release or built earlier); pass --build (or set
// SYNC_RUNNER_BUILD=1) to rebuild the backend repo and copy the fresh binary
// — for testing backend changes over F5.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const TARGETS = [
  { repo: 'type-like-chuck-backed-openvino', dir: 'binaries/ovgenai/win32-x64', asset: 'tlc-ovgenai-runner-win32-x64.exe', finalName: 'tlc-ovgenai-runner.exe', platform: 'win32' },
  { repo: 'type-like-chuck-backed-openvino', dir: 'binaries/ovgenai/linux-x64', asset: 'tlc-ovgenai-runner-linux-x64', finalName: 'tlc-ovgenai-runner', platform: 'linux' },
  { repo: 'type-like-chuck-backed-mlx', dir: 'binaries/mlx/darwin-arm64', asset: 'tlc-mlx-runner-macos-arm64', finalName: 'tlc-mlx-runner', platform: 'darwin' },
];

const target = TARGETS.find((t) => t.platform === process.platform);
if (target === undefined) {
  console.error(`No runner target for platform ${process.platform}`);
  process.exit(1);
}

const destination = join(root, target.dir, target.finalName);
const forceBuild = process.argv.includes('--build') || process.env.SYNC_RUNNER_BUILD === '1';
if (!forceBuild && existsSync(destination)) {
  console.log(`runner binary present: ${target.dir}/${target.finalName} (use --build to rebuild from the backend repo)`);
  process.exit(0);
}

const backendRoot = join(root, '..', target.repo);
if (!existsSync(backendRoot)) {
  console.error(`Backend repo not found: ${backendRoot}`);
  process.exit(1);
}

console.log(`Building ${target.repo} (task build)...`);
const build = spawnSync('task', ['build'], { cwd: backendRoot, stdio: 'inherit', shell: process.platform === 'win32' });
if (build.status !== 0) {
  console.error(`task build failed with code ${build.status}`);
  process.exit(build.status ?? 1);
}

const built = join(backendRoot, 'build', target.asset);
if (!existsSync(built)) {
  console.error(`Build output missing: ${built}`);
  process.exit(1);
}

mkdirSync(dirname(destination), { recursive: true });
// The source exe was just linked/used and may be briefly locked; retry.
for (let attempt = 1; ; attempt++) {
  try {
    copyFileSync(built, destination);
    break;
  } catch (error) {
    if (attempt >= 5 || (error.code !== 'EBUSY' && error.code !== 'EPERM')) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
console.log(`Copied ${built} -> ${destination}`);

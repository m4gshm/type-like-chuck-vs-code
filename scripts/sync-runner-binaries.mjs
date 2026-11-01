#!/usr/bin/env node
// Builds the backend runner repo for the host platform and copies the fresh
// binary into binaries/<engine>/<platform>/ with the name the extension
// resolves at runtime — so F5 testing always runs the current backend.
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

const destination = join(root, target.dir, target.finalName);
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

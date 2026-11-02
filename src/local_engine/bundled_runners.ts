/** Platform label under binaries/ovgenai; undefined when no runner is bundled. */
function ovgenaiPlatformDir(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === 'win32' && arch === 'x64') {
    return 'win32-x64';
  }
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    return arch === 'x64' ? 'linux-x64' : 'linux-arm64';
  }
  return undefined;
}

export function bundledOvgenaiRunnerPath(extensionPath: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  const dir = ovgenaiPlatformDir(platform, arch);
  if (dir === undefined) {
    return undefined;
  }
  const binary = platform === 'win32' ? 'tlc-ovgenai-runner.exe' : 'tlc-ovgenai-runner';
  // TLC_RUNNER_DIR selects the binaries/<engine> folder; the F5 "release" launch
  // configuration points it at the pinned backend release download.
  const engineDir = process.env.TLC_RUNNER_DIR?.trim() || 'ovgenai';
  return `${extensionPath}/binaries/${engineDir}/${dir}/${binary}`;
}

/** Path of the bundled mlx runner; defined on macOS arm64 only. */
export function bundledMlxRunnerPath(extensionPath: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  if (platform !== 'darwin' || arch !== 'arm64') {
    return undefined;
  }
  return `${extensionPath}/binaries/mlx/darwin-arm64/tlc-mlx-runner`;
}

import { existsSync, readdirSync } from 'fs';
import { mkdir, readdir, rename, rm } from 'fs/promises';
import { join } from 'path';

export interface EnginePathSettings {
  engineDir: string;
  modelDir: string;
  modelCacheDir: string;
}

export interface EnginePaths {
  engineRoot: string;
  modelDir: string;
  modelCacheDir: string;
}

/** Empty settings resolve to defaults under the extension's global storage root. */
export function resolveEnginePaths(settings: EnginePathSettings, defaultRoot: string): EnginePaths {
  return {
    engineRoot: settings.engineDir.length > 0 ? settings.engineDir : join(defaultRoot, 'engine'),
    modelDir: settings.modelDir.length > 0 ? settings.modelDir : join(defaultRoot, 'models'),
    modelCacheDir: settings.modelCacheDir.length > 0 ? settings.modelCacheDir : join(defaultRoot, 'ov-cache'),
  };
}

/**
 * Moves oldPath to newPath when the old location has content and the new one
 * does not exist (or is empty). Returns the moved path, or undefined when the
 * content stays where it is.
 */
export async function migrateDirectory(oldPath: string, newPath: string): Promise<string | undefined> {
  if (oldPath === newPath || !existsSync(oldPath) || isNonEmpty(newPath)) {
    return undefined;
  }
  if (!existsSync(newPath)) {
    await mkdir(newPath, { recursive: true });
  }
  for (const entry of await readdir(oldPath)) {
    await rename(join(oldPath, entry), join(newPath, entry));
  }
  await rm(oldPath, { recursive: true, force: true });
  return newPath;
}

function isNonEmpty(path: string): boolean {
  try {
    return existsSync(path) && readdirSync(path).length > 0;
  } catch {
    // A race or permission error means "assume populated": nothing existing
    // is ever overwritten by a migration.
    return true;
  }
}

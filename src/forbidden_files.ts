import micromatch from 'micromatch';

/** Glob-based gate that disables completions in matching files (e.g. .env). */
export class ForbiddenFiles {
  constructor(private readonly patterns: readonly string[]) {}

  isForbidden(fileName: string): boolean {
    if (this.patterns.length === 0) {
      return false;
    }
    const base = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
    return micromatch.isMatch(base, this.patterns as string[], { basename: true })
      || micromatch.isMatch(fileName.replace(/\\/g, '/'), this.patterns as string[]);
  }
}

import micromatch from 'micromatch';

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

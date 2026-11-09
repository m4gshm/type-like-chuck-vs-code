import { describe, expect, it } from 'vitest';
import { ForbiddenFiles } from '../../forbidden_files';

describe('ForbiddenFiles', () => {
  it('forbids files matching a literal glob like .env', () => {
    const f = new ForbiddenFiles(['.env']);
    expect(f.isForbidden('C:/proj/.env')).toBe(true);
    expect(f.isForbidden('C:/proj/src/main.go')).toBe(false);
  });

  it('supports wildcard globs', () => {
    const f = new ForbiddenFiles(['.env', '*.secret']);
    expect(f.isForbidden('keys.secret')).toBe(true);
    expect(f.isForbidden('C:/x/y/creds.secret')).toBe(true);
    expect(f.isForbidden('main.py')).toBe(false);
  });

  it('allows everything with an empty pattern list', () => {
    expect(new ForbiddenFiles([]).isForbidden('.env')).toBe(false);
  });
});

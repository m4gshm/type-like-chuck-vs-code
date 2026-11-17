#!/usr/bin/env node
// Stamps the package.json version as <base>-<flavor>.<YYYYMMDD-HHMM> so the
// installed build is identifiable in VS Code next to a release (plain
// <base>) and a GitHub nightly (<base>-build.<date>). Mutates the working
// tree only (like the vsix.yml stamp step); commit nothing afterwards.
// Usage: node scripts/stamp-version.mjs [flavor=local]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const flavor = process.argv[2] ?? 'local';
const base = pkg.version.split('-')[0];
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
pkg.version = `${base}-${flavor}.${stamp}`;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`version stamped: ${pkg.version}`);

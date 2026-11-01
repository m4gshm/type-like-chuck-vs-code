const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').Plugin} */
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    const report = (level, mark) => ({ text, location }) => {
      console.error(`${mark} [${level}] ${text}`);
      if (location) {
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      }
    };
    build.onEnd((result) => {
      result.errors.forEach(report('ERROR', '✘'));
      result.warnings.forEach(report('WARNING', '▲'));
      console.log('[watch] build finished');
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
};

(async () => {
  const ctx = await esbuild.context(extensionConfig);
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

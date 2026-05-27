import esbuild from 'esbuild';
import process from 'node:process';

const watch = process.argv.includes('--watch');

const shared = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  external: ['vscode'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

const desktopBuild = {
  ...shared,
  outfile: 'dist/extension/desktop.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
};

const webBuild = {
  ...shared,
  outfile: 'dist/extension/web.js',
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  mainFields: ['browser', 'module', 'main'],
  conditions: ['browser'],
};

async function run() {
  if (watch) {
    const ctxs = await Promise.all([
      esbuild.context(desktopBuild),
      esbuild.context(webBuild),
    ]);
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('esbuild: watching desktop.js + web.js');
  } else {
    await Promise.all([
      esbuild.build(desktopBuild),
      esbuild.build(webBuild),
    ]);
    console.log('esbuild: built dist/extension/{desktop,web}.js');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

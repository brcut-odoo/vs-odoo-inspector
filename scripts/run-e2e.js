// Bundles scripts/e2e.ts with the view plugin (it imports `view:*`) and runs it.
const esbuild = require('esbuild');
const { execFileSync } = require('node:child_process');
const { viewPlugin } = require('../esbuild.js');

esbuild
	.build({ entryPoints: ['scripts/e2e.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: 'out/e2e.js', plugins: [viewPlugin], logLevel: 'warning' })
	.then(() => execFileSync(process.execPath, ['out/e2e.js'], { stdio: 'inherit' }))
	.catch(() => process.exit(1));

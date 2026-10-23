// Builds two kinds of bundle:
//  - each MCP Apps view (browser IIFE + CSS), inlined into one self-contained HTML string;
//  - the extension (Node CJS), which imports those strings as `view:<name>`.
const esbuild = require('esbuild');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** View name → entry point. The view's CSS is imported from its entry. */
const VIEWS = {
	approval: 'src/view/approval.ts',
};

async function buildView(entry) {
	const result = await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		minify: production,
		outdir: 'out-view',
		loader: { '.css': 'css' },
	});
	const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
	const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
	// `</script` inside the bundle would end the inline script early.
	const safeJs = js.replace(/<\/script/gi, '<\\/script');
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="app"></div><script>${safeJs}</script></body></html>`;
}

/** Resolves `view:<name>` imports to the built HTML of that view. */
const viewPlugin = {
	name: 'views',
	setup(build) {
		build.onResolve({ filter: /^view:/ }, (args) => ({ path: args.path.slice(5), namespace: 'view' }));
		build.onLoad({ filter: /.*/, namespace: 'view' }, async (args) => {
			const entry = VIEWS[args.path];
			if (!entry) {
				return { errors: [{ text: `Unknown view "${args.path}"` }] };
			}
			return {
				contents: await buildView(entry),
				loader: 'text',
				watchFiles: [path.resolve(entry)],
				watchDirs: [path.resolve(path.dirname(entry))],
			};
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: 'node20',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'info',
		plugins: [viewPlugin],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

module.exports = { viewPlugin, buildView };

if (require.main === module) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}

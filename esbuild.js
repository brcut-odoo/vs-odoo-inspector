const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/**
 * Copies the webview stylesheet next to the bundled script.
 *
 * @type {import('esbuild').Plugin}
 */
const copyWebviewAssetsPlugin = {
	name: 'copy-webview-assets',
	setup(build) {
		build.onEnd(() => {
			const source = path.join(__dirname, 'src', 'ui', 'workbench', 'style.css');
			const target = path.join(__dirname, 'dist', 'webview', 'workbench.css');
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.copyFileSync(source, target);
		});
	},
};

/** Shared options for the two Node (extension host / MCP server) bundles. */
const nodeOptions = {
	bundle: true,
	format: 'cjs',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'node',
	logLevel: 'silent',
};

async function main() {
	// 1. Extension host.
	const extensionCtx = await esbuild.context({
		...nodeOptions,
		entryPoints: ['src/extension.ts'],
		outfile: 'dist/extension.js',
		external: ['vscode'],
		plugins: [esbuildProblemMatcherPlugin],
	});

	// 2. Standalone stdio MCP server. Bundles the SDK so the process is
	//    self-contained; `vscode` is never imported here.
	const mcpCtx = await esbuild.context({
		...nodeOptions,
		entryPoints: ['src/mcpServer.ts'],
		outfile: 'dist/mcpServer.js',
		external: ['vscode'],
		plugins: [esbuildProblemMatcherPlugin],
	});

	// 3. Webview front-end. Runs in a browser context, so it must be IIFE
	//    and must not pull in Node built-ins.
	const webviewCtx = await esbuild.context({
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		target: 'es2022',
		entryPoints: ['src/ui/workbench/main.ts'],
		outfile: 'dist/webview/workbench.js',
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin, copyWebviewAssetsPlugin],
	});

	const contexts = [extensionCtx, mcpCtx, webviewCtx];

	if (watch) {
		await Promise.all(contexts.map((ctx) => ctx.watch()));
	} else {
		await Promise.all(contexts.map((ctx) => ctx.rebuild()));
		await Promise.all(contexts.map((ctx) => ctx.dispose()));
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});

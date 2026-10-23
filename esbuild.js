const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Number of bundles currently building.
 *
 * The three entry points build in parallel, so the start/finish markers are
 * only emitted for the first start and the last finish. Emitting them per
 * build would let an early finish close the problem matcher's window while
 * another bundle is still reporting errors.
 */
let activeBuilds = 0;

/**
 * Emits the markers and error format expected by the `odoo-esbuild-watch`
 * problem matcher in `.vscode/tasks.json`.
 *
 * @param {string} label
 * @returns {import('esbuild').Plugin}
 */
function esbuildProblemMatcherPlugin(label) {
	return {
		name: `esbuild-problem-matcher-${label}`,

		setup(build) {
			build.onStart(() => {
				if (activeBuilds++ === 0) {
					console.log('[watch] build started');
				}
			});
			build.onEnd((result) => {
				result.errors.forEach(({ text, location }) => {
					// One line per error, in the `file:line:column: message` shape
					// the problem matcher in .vscode/tasks.json expects.
					if (location) {
						console.error(
							`✘ [ERROR] ${location.file}:${location.line}:${location.column}: ${text}`,
						);
					} else {
						console.error(`✘ [ERROR] ${text}`);
					}
				});
				if (--activeBuilds === 0) {
					console.log('[watch] build finished');
				}
			});
		},
	};
}

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
		plugins: [esbuildProblemMatcherPlugin('extension')],
	});

	// 2. Standalone stdio MCP server. Bundles the SDK so the process is
	//    self-contained; `vscode` is never imported here.
	const mcpCtx = await esbuild.context({
		...nodeOptions,
		entryPoints: ['src/mcpServer.ts'],
		outfile: 'dist/mcpServer.js',
		external: ['vscode'],
		plugins: [esbuildProblemMatcherPlugin('mcp')],
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
		plugins: [esbuildProblemMatcherPlugin('webview'), copyWebviewAssetsPlugin],
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

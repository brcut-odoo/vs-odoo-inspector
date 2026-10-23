// Builds the approval view and a fake host, then drives them in headless Chrome.
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildView } = require('../esbuild.js');

(async () => {
	const viewHtml = await buildView('src/view/approval.ts');
	const host = await esbuild.build({ entryPoints: ['scripts/view-host.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', define: { VIEW_HTML: JSON.stringify(viewHtml) } });
	fs.mkdirSync('out', { recursive: true });
	const file = path.resolve('out/view-host.html');
	fs.writeFileSync(file, `<!DOCTYPE html><html><body><pre id="report"></pre><script>${host.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`);
	const chrome = process.env.CHROME ?? 'google-chrome';
	const dom = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files', '--virtual-time-budget=15000', '--dump-dom', `file://${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const start = dom.indexOf('<pre id="report">') + '<pre id="report">'.length;
	const report = dom.slice(start, dom.indexOf('</pre>', start));
	const text = report.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
	console.log(text);
	process.exit(text.includes('VIEW CHECK PASSED') ? 0 : 1);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});

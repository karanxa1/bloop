// Browser builds imported as raw source text via the wrangler.toml [[rules]]
// Text rule; they are evaluated inside the rendered page, not in the worker.
declare module "@mozilla/readability/Readability.js" {
	const source: string;
	export default source;
}
declare module "turndown/dist/turndown.js" {
	const source: string;
	export default source;
}
declare module "turndown-plugin-gfm/dist/turndown-plugin-gfm.js" {
	const source: string;
	export default source;
}

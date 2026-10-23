/**
 * Rate limiter, ported from `support-tools/lib/utils.py::RateLimiter`.
 *
 * Odoo SaaS/PaaS instances throttle aggressively, so the default is one
 * request per second. Local instances can raise this via configuration.
 */
export class RateLimiter {
	private nextActionAfter = 0;

	constructor(private readonly maxPerSecond: number = 1) {}

	/** Resolves once the caller is allowed to issue the next request. */
	async waitUntilReady(): Promise<void> {
		if (this.maxPerSecond <= 0) {
			return;
		}
		const now = Date.now();
		const wait = this.nextActionAfter - now;
		if (wait > 0) {
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
		this.actionDone();
	}

	/** Marks a request as issued, scheduling the next allowed slot. */
	actionDone(): void {
		if (this.maxPerSecond <= 0) {
			return;
		}
		this.nextActionAfter = Date.now() + 1000 / this.maxPerSecond;
	}
}

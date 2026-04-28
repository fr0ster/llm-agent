/**
 * Token-bucket rate limiter.
 *
 * Allows up to `maxRequests` in a rolling `windowMs` window.
 * When the bucket is empty, `acquire()` blocks until a slot frees up.
 */
export class TokenBucketRateLimiter {
    maxRequests;
    windowMs;
    timestamps = [];
    constructor(config) {
        this.maxRequests = config.maxRequests;
        this.windowMs = config.windowMs ?? 60_000;
    }
    async acquire() {
        const now = Date.now();
        this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
        if (this.timestamps.length < this.maxRequests) {
            this.timestamps.push(now);
            return;
        }
        // Wait until the oldest request expires from the window
        const oldest = this.timestamps[0];
        const waitMs = oldest + this.windowMs - now + 1;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        // Clean up and record
        const after = Date.now();
        this.timestamps = this.timestamps.filter((t) => after - t < this.windowMs);
        this.timestamps.push(after);
    }
}
//# sourceMappingURL=token-bucket-rate-limiter.js.map
import { createHash } from 'node:crypto';
export class ToolCache {
  map = new Map();
  ttlMs;
  constructor(opts) {
    this.ttlMs = opts?.ttlMs ?? 300_000;
  }
  get(toolName, args) {
    const key = this._key(toolName, args);
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.result;
  }
  set(toolName, args, result) {
    const key = this._key(toolName, args);
    this.map.set(key, { result, expiresAt: Date.now() + this.ttlMs });
  }
  clear() {
    this.map.clear();
  }
  _key(toolName, args) {
    const sorted = JSON.stringify(args, Object.keys(args).sort());
    const hash = createHash('sha256').update(sorted).digest('hex');
    return `${toolName}:${hash}`;
  }
}
//# sourceMappingURL=tool-cache.js.map

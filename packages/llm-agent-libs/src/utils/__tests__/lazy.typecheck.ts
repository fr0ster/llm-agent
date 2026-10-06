import { lazy } from '../lazy.js';

interface IGreeter {
  greet(n: string): Promise<string>;
}
const g: IGreeter = { greet: async (n) => n };
// @ts-expect-error — `fallback` was removed (U6, migration line 73)
lazy<IGreeter>(() => g, { fallback: g });

import { type LazyOptions, lazy } from '../lazy.js';

interface IGreeter {
  greet(n: string): Promise<string>;
}
const g: IGreeter = { greet: async (n) => n };
// @ts-expect-error — `fallback` was removed (U6, migration line 73)
lazy<IGreeter>(() => g, { fallback: g });

// `LazyOptions` is not generic (U6: nothing of `T` is left in it).
const options: LazyOptions = { retryIntervalMs: 10, onError: () => {} };
lazy<IGreeter>(() => g, options);
// @ts-expect-error — `LazyOptions` takes no type argument
type _Generic = LazyOptions<IGreeter>;

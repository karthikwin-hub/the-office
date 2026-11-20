/** The part of Node's async_hooks the Workers runtime gives with nodejs_compat, for log.ts. The package types here are Workers', not Node's. */
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, fn: () => R): R;
    getStore(): T | undefined;
  }
}

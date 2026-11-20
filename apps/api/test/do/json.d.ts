// Saved offices (saved/*.json) are read as data and checked by the tests; tsc need not infer their types.
declare module "*.json" {
  const value: unknown;
  export default value;
}

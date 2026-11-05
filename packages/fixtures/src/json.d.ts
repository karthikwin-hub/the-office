// The 2 MB dataset is validated at runtime by the Books schema; letting tsc infer its type would stall the compiler.
declare module "*/office.json" {
  const value: unknown;
  export default value;
}

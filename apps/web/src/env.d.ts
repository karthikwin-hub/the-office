/// <reference types="vite/client" />

declare module "virtual:legal" {
  const pages: Record<import("@office/contracts").LegalPage, string>;
  export default pages;
}

interface ImportMetaEnv {
  readonly VITE_DATA?: "mock" | "hybrid" | "live";
  readonly VITE_LIVE_ROUTES?: string;
}

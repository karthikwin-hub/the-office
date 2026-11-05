/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA?: "mock" | "hybrid" | "live";
  readonly VITE_LIVE_ROUTES?: string;
}

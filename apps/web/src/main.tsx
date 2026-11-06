import "@office/ui/styles.css";
import "./app/app.css";
import "./app/more.css";
import "./app/compliance.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isLive } from "./api/client";
import { router } from "./app/router";
import { loadSite, place } from "./app/site";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } } });

async function boot() {
  if (import.meta.env.VITE_DATA === "mock" || import.meta.env.VITE_DATA === "hybrid") {
    const { startMocks } = await import("./mocks/browser");
    await startMocks();
  }
  if (isLive) await loadSite();
  const root = createRoot(document.getElementById("root")!);
  if (place().kind === "product" || (!isLive && new URLSearchParams(location.search).has("product"))) {
    const { ProductPage } = await import("./app/Product");
    root.render(
      <StrictMode>
        <ProductPage />
      </StrictMode>,
    );
    return;
  }
  if (place().kind === "platform") {
    const { PlatformConsole } = await import("./app/Platform");
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <PlatformConsole />
        </QueryClientProvider>
      </StrictMode>,
    );
    return;
  }
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} context={{ queryClient }} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void boot();

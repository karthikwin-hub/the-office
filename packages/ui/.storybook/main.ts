import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-essentials", "@storybook/addon-a11y"],
  framework: { name: "@storybook/react-vite", options: {} },
  staticDirs: [{ from: "../../../apps/web/public/docs", to: "/docs" }],
  core: { disableTelemetry: true },
};

export default config;

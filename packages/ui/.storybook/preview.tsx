import type { Preview } from "@storybook/react";
import { FigureContext } from "../src/Figure";
import "../src/styles.css";

const preview: Preview = {
  parameters: {
    layout: "padded",
    backgrounds: { default: "paper", values: [{ name: "paper", value: "#f3f5f7" }] },
    controls: { expanded: true },
  },
  decorators: [
    (Story) => (
      <FigureContext.Provider value={{ open: (id) => console.info("open figure", id), openDocument: (id, region) => console.info("open document", id, region) }}>
        <Story />
      </FigureContext.Provider>
    ),
  ],
};

export default preview;

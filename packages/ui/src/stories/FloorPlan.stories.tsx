import type { Meta, StoryObj } from "@storybook/react";
import { FloorPlan } from "../FloorPlan";
import { newOffice, view } from "./data";

const meta: Meta<typeof FloorPlan> = {
  title: "Floor/FloorPlan",
  component: FloorPlan,
  args: { rooms: view.rooms, arriving: [] },
  parameters: { layout: "fullscreen" },
  decorators: [(S) => <div style={{ padding: 24, maxWidth: 1280 }}>{S()}</div>],
};
export default meta;
type Story = StoryObj<typeof FloorPlan>;

export const Today: Story = {};

export const DocumentArriving: Story = { args: { arriving: view.arriving } };

export const FirstWeek: Story = { args: { rooms: newOffice().rooms } };

export const EverythingIdle: Story = {
  args: { rooms: view.rooms.map((r) => (r.hired ? { ...r, status: "idle" as const, waitingCount: 0, now: "Nothing new today", todayCount: 0 } : r)) },
};

export const Narrow: Story = {
  args: { layout: "narrow", arriving: view.arriving },
  decorators: [(S) => <div style={{ maxWidth: 400 }}>{S()}</div>],
  parameters: { viewport: { defaultViewport: "mobile2" } },
};

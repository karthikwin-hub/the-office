import type { LogEntry } from "@office/contracts";
import type { Meta, StoryObj } from "@storybook/react";
import type { CSSProperties } from "react";
import { FloorPlan } from "../FloorPlan";
import { LivingFloor } from "../living/LivingFloor";
import { PERSONAS } from "../living/personas";
import { SKIN_BY_ID, skinStyle } from "../skins";
import { view } from "./data";

type Args = { busy: boolean; waiting: boolean; birthday: boolean; reducedMotion: boolean };
const today = new Date().toISOString().slice(0, 10);

function LivedIn({ busy, waiting, birthday, reducedMotion }: Args) {
  const rooms = view.rooms.map((r) => (r.hired ? { ...r, status: busy && r.agentId === "accountant" ? ("working" as const) : ("idle" as const), waitingCount: waiting && r.agentId === "credit-controller" ? 3 : 0 } : r));
  const log: LogEntry[] = busy ? [{ id: "story-1", at: new Date().toISOString(), agentId: "accountant", text: "Read a bill from Narmada Switchgear and left it on your desk for the Credit controller to see.", ref: null }] : [];
  const ambient = { today: birthday ? `${today.slice(0, 4)}-${PERSONAS.accountant!.birthday}` : today, names: {}, festivals: [], hiredOn: {} };
  const skin = SKIN_BY_ID["lived-in"];
  return (
    <div style={{ ...(skinStyle(skin) as CSSProperties), background: "var(--paper)", padding: 24, maxWidth: 1280 }} data-skin={skin.id}>
      <FloorPlan rooms={rooms} arriving={[]} texture={skin.texture} overlay={(plan) => <LivingFloor plan={plan} inputs={{ rooms, log, arriving: [], ambient, weather: { city: "Pune", tempC: 26, sky: "rain", at: new Date().toISOString() } }} seed={4} reducedMotion={reducedMotion} />} />
    </div>
  );
}

const meta: Meta<typeof LivedIn> = {
  title: "Floor/Lived-in office",
  component: LivedIn,
  args: { busy: false, waiting: false, birthday: false, reducedMotion: false },
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof LivedIn>;

/** Everyone free: within half a minute two of them go for tea. */
export const Idle: Story = {};
/** The Accountant is working and says what it just did, in the log's words; nobody chats. */
export const Busy: Story = { args: { busy: true } };
/** The Credit Controller waits at the door with a sheet: three things are on your desk. */
export const Waiting: Story = { args: { waiting: true } };
export const Birthday: Story = { args: { birthday: true } };
export const ReducedMotion: Story = { args: { busy: true, reducedMotion: true } };

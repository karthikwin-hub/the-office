import type { TrustLevel as Level } from "@office/contracts";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { HireCard } from "../HireCard";
import { TeamLog } from "../TeamLog";
import { TrustLevel } from "../TrustLevel";
import { office, view } from "./data";

const meta: Meta = { title: "People/Trust, hiring and the log" };
export default meta;

function Interactive({ initial }: { initial: Level }) {
  const [l, set] = useState<Level>(initial);
  return <TrustLevel level={l} onChange={set} />;
}
export const TrustTrainee: StoryObj = { render: () => <Interactive initial="trainee" /> };
export const TrustTrusted: StoryObj = { render: () => <Interactive initial="trusted" /> };
export const TrustAutonomous: StoryObj = { render: () => <Interactive initial="autonomous" /> };
export const TrustLocked: StoryObj = { render: () => <TrustLevel level="trusted" onChange={() => {}} disabled /> };
export const TrustCompact: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gap: 8 }}>
      <TrustLevel level="trainee" compact />
      <TrustLevel level="trusted" compact />
      <TrustLevel level="autonomous" compact />
    </div>
  ),
};

const agent = (id: string) => office.books.agents.find((a) => a.agentId === id)!;
export const HireHired: StoryObj = { render: () => <HireCard state={agent("accountant")} onLetGo={() => {}} /> };
export const HireNotHired: StoryObj = { render: () => <HireCard state={agent("payroll-clerk")} onHire={() => {}} /> };
export const HireReadOnly: StoryObj = { render: () => <HireCard state={agent("buyer")} readOnly /> };

export const LogToday: StoryObj = { render: () => <div style={{ maxWidth: 360 }}><TeamLog entries={view.log} /></div> };
export const LogOneAgent: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 560 }}>
      <TeamLog title="What the Accountant did" entries={office.agentRoom("accountant").log.slice(0, 8)} showAgent={false} />
    </div>
  ),
};
export const LogEmpty: StoryObj = { render: () => <TeamLog entries={[]} empty="Nothing yet. The team starts at 9:00." /> };

import type { StagedChange } from "@office/contracts";
import type { Meta, StoryObj } from "@storybook/react";
import { ApprovalCard } from "../ApprovalCard";
import { byKind, desk } from "./data";

const meta: Meta<typeof ApprovalCard> = {
  title: "Desk/ApprovalCard",
  component: ApprovalCard,
  args: { onDecide: (d) => console.info("decide", d) },
  decorators: [(S) => <div style={{ maxWidth: 760 }}>{S()}</div>],
};
export default meta;
type Story = StoryObj<typeof ApprovalCard>;

export const PostBill: Story = { args: { item: byKind("ledger_entry") } };
export const SendReminder: Story = { args: { item: byKind("reminder") } };
export const RaiseWithAccountant: Story = { args: { item: byKind("audit_flag") } };
export const ShareFile: Story = { args: { item: byKind("share_file") } };
export const SendQuotation: Story = { args: { item: byKind("quote") } };
export const ScheduleCampaign: Story = { args: { item: byKind("campaign") } };
export const SchedulePost: Story = { args: { item: byKind("post") } };
export const PostReply: Story = {
  args: { item: byKind("social_reply"), context: { "Prashant K. wrote": "Ordered a fan regulator, got the wrong model. Store sorted it the next day but I had to go twice." } },
};
export const ApproveCalendar: Story = { args: { item: byKind("calendar") } };
export const SendBroadcast: Story = { args: { item: byKind("broadcast"), context: { "Goes to": "420 customers who agreed to hear from you on WhatsApp" } } };
export const SendOrder: Story = { args: { item: byKind("purchase_order") } };
export const Busy: Story = { args: { item: byKind("reminder"), busy: true } };
export const ReadOnlyForAccountant: Story = { args: { item: byKind("reminder"), readOnly: "Only the owner can send reminders." } };

const decided = (status: StagedChange["status"], note?: string): StagedChange => ({ ...byKind("reminder"), status, decidedAt: "2026-11-04T12:48:00.000Z", decidedBy: "Anil Kulkarni", note });
export const Approved: Story = { args: { item: decided("approved") } };
export const Rejected: Story = { args: { item: decided("rejected", "They paid by cheque yesterday; it clears on Friday.") } };

export const WholeDesk: Story = {
  render: (args) => (
    <div>
      {desk.items.map((i) => (
        <ApprovalCard key={i.id} {...args} item={i} />
      ))}
    </div>
  ),
};

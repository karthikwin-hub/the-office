import type { Meta, StoryObj } from "@storybook/react";
import { socialReport } from "@office/engine";
import { CalendarGrid } from "../CalendarGrid";
import { ChannelStrip } from "../ChannelStrip";
import { PostChecks, PostPreview } from "../PostPreview";
import { office } from "./data";

const social = socialReport(office.ledger);
const post = (id: string) => social.posts.find((p) => p.id === id)!;
const channel = (id: string) => social.channels.find((c) => c.id === id);

const meta: Meta = { title: "Social" };
export default meta;

function Copies({ id, edit }: { id: string; edit?: boolean }) {
  const p = post(id);
  const checks = social.checks[p.id] ?? [];
  return (
    <div style={{ maxWidth: 980 }}>
      <PostChecks checks={checks} />
      <div className="post-copies">
        {p.variants.map((v) => (
          <PostPreview key={v.channelId} variant={v} channel={channel(v.channelId)} facts={p.facts} media={social.media} checks={checks} at={p.at} onSave={edit ? (t) => console.info("save", v.channelId, t) : undefined} />
        ))}
      </div>
    </div>
  );
}

export const PublishedWithResults: StoryObj = { render: () => <Copies id="post-01" /> };
export const ScheduledFromTheCalendar: StoryObj = { render: () => <Copies id="post-05" edit /> };
export const ChangedAfterApproval: StoryObj = { render: () => <Copies id="post-07" edit /> };
export const FailsItsChecks: StoryObj = { render: () => <Copies id="post-09" edit /> };

export const Channels: StoryObj = { render: () => <ChannelStrip channels={social.channels} /> };
export const ChannelsForTheOwner: StoryObj = {
  render: () => <ChannelStrip channels={social.channels} onConnect={(c) => console.info("connect", c.id)} onManual={(c) => console.info("manual", c.id)} />,
};

const festivals = office.books.festivalCalendar;
export const ApprovedMonth: StoryObj = {
  render: () => <CalendarGrid calendar={social.calendars.find((c) => c.id === "cal-2026-11")!} pillars={social.voice.pillars} posts={social.posts} festivals={festivals} onOpen={(id) => console.info("open", id)} />,
};
export const DraftMonth: StoryObj = {
  render: () => <CalendarGrid calendar={social.calendars.find((c) => c.id === "cal-2026-12")!} pillars={social.voice.pillars} posts={social.posts} festivals={festivals} />,
};
export const PhoneWidth: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 380 }}>
      <CalendarGrid calendar={social.calendars.find((c) => c.id === "cal-2026-11")!} pillars={social.voice.pillars} posts={social.posts} festivals={festivals} />
    </div>
  ),
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

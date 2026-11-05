import type { Post, SocialMessage, SocialReport, StagedChange } from "@office/contracts";
import { PLATFORM_NAMES } from "@office/contracts";
import { nextMonth } from "@office/engine";
import { Amount, CalendarGrid, ChannelStrip, CoveringNote, Figure, LedgerTable, PostChecks, PostPreview } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { api } from "../api/client";
import { q, useSocial } from "../api/queries";
import { count, isOwner, Section, shortDate } from "../screens/common";
import { FrameMaker, MetricsImport, PublishingPackCard } from "./social-manual";

const pct = (n: number) => `${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
const thisMonth = (asOf: string) => asOf.slice(0, 7);

/** Every channel's version of one post, with the checks that apply to all of them. */
export function PostCard({ post, report, editable }: { post: Post; report: SocialReport; editable?: boolean }) {
  const social = useSocial();
  const checks = report.checks[post.id] ?? [];
  const channel = (id: string) => report.channels.find((c) => c.id === id);
  return (
    <div className="post-card" id={`post-${post.id}`}>
      <h3 className="post-card-title">
        {post.topic} <span className="muted">{`${shortDate(post.at)}, ${post.at.slice(11, 16)}`}</span>
      </h3>
      <PostChecks checks={checks} />
      <div className="post-copies">
        {post.variants.map((v) => (
          <PostPreview
            key={v.channelId}
            variant={v}
            channel={channel(v.channelId)}
            facts={post.facts}
            media={report.media}
            checks={checks}
            at={post.at}
            busy={social.isPending}
            onSave={editable ? (text) => social.mutate(() => api.editVariant(post.id, v.channelId, { text })) : undefined}
          />
        ))}
      </div>
      {editable && post.status !== "published" ? <FrameMaker post={post} report={report} /> : null}
    </div>
  );
}

/** What the desk shows inside a social approval: the versions of a post, the month's plan, a broadcast's cost. */
export function useApprovalBody() {
  const social = useQuery(q.social());
  const marketing = useQuery(q.marketing());
  return (i: StagedChange): ReactNode => {
    const r = social.data;
    if (!r) return null;
    const p = i.payload as { postId?: string; calendarId?: string; audience?: number; costPaise?: number; text?: string };
    if (i.kind === "post") {
      const post = r.posts.find((x) => x.id === p.postId);
      return post ? <PostCard post={post} report={r} editable={isOwner() && i.status === "pending"} /> : null;
    }
    if (i.kind === "calendar") {
      const cal = r.calendars.find((c) => c.id === p.calendarId);
      return cal ? <CalendarGrid calendar={cal} pillars={r.voice.pillars} posts={r.posts} festivals={marketing.data?.calendar} /> : null;
    }
    if (i.kind === "broadcast") {
      return (
        <dl className="approval-context">
          <div>
            <dt>Goes to</dt>
            <dd>{count(p.audience ?? 0, "customer")} who agreed to hear from you on WhatsApp</dd>
          </div>
          <div>
            <dt>Costs about</dt>
            <dd>
              <Amount paise={p.costPaise ?? 0} rupees /> at Meta's marketing rate for India
            </dd>
          </div>
          <div>
            <dt>Message</dt>
            <dd className="approval-body">{p.text}</dd>
          </div>
        </dl>
      );
    }
    return null;
  };
}

/** The Social Media Manager's room: channels, the month, what needs posting by hand, the inbox and drafts. */
export function SocialRoomPanel({ report }: { report: SocialReport }) {
  const owner = isOwner();
  const social = useSocial();
  const office = useQuery(q.office());
  const marketing = useQuery(q.marketing());
  const asOf = office.data?.business.asOf ?? new Date().toISOString().slice(0, 10);
  const month = thisMonth(asOf);
  const next = nextMonth(month);
  const current = report.calendars.find((c) => c.month === month && c.status !== "superseded");
  const upcoming = report.calendars.find((c) => c.month === next && c.status !== "superseded");
  const byHand = report.posts.flatMap((p) => p.variants.filter((v) => v.status === "scheduled" && report.channels.find((c) => c.id === v.channelId)?.status !== "connected").map((v) => ({ post: p, v })));
  const drafts = report.posts.filter((p) => p.status !== "published" && !p.calendarId).concat(report.posts.filter((p) => p.status === "draft" && p.calendarId));
  const festivals = marketing.data?.calendar;
  const open = (id: string) => document.getElementById(`post-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <>
      <Section title="Channels" aside={owner ? <Link to="/settings" hash="channels">Channel settings</Link> : null}>
        <ChannelStrip
          channels={report.channels}
          busy={social.isPending}
          onConnect={owner ? (c) => social.mutate(() => api.connectChannel(c.platform)) : undefined}
          onManual={owner ? (c) => social.mutate(() => api.setupChannel(c.id, { mode: "manual" })) : undefined}
        />
      </Section>
      <Section
        title="The month"
        aside={
          owner && !upcoming ? (
            <button type="button" className="btn" disabled={social.isPending} onClick={() => social.mutate(() => api.draftCalendar(next))}>
              Draft the {new Date(`${next}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", timeZone: "UTC" })} calendar
            </button>
          ) : null
        }
      >
        {current ? <CalendarGrid calendar={current} pillars={report.voice.pillars} posts={report.posts} festivals={festivals} onOpen={open} /> : <p className="section-lede">No calendar for this month yet. Draft one and it comes to your desk to approve as a whole.</p>}
        {upcoming ? <CalendarGrid calendar={upcoming} pillars={report.voice.pillars} posts={report.posts} festivals={festivals} onOpen={open} /> : null}
      </Section>
      {byHand.length ? (
        <Section title={`To post by hand (${byHand.length})`}>
          <p className="section-lede">These channels are not connected, or the platform is limiting posts. Copy the text and pictures, post them, then paste the link so the results can be matched later.</p>
          {byHand.map(({ post, v }) => (
            <PublishingPackCard key={post.id + v.channelId} post={post} variant={v} report={report} />
          ))}
        </Section>
      ) : null}
      <InboxThreads report={report} />
      {drafts.length ? (
        <Section title={`Drafts (${drafts.length})`}>
          {drafts.map((p) => (
            <PostCard key={p.id} post={p} report={report} editable={owner} />
          ))}
        </Section>
      ) : null}
    </>
  );
}

const KIND: Record<SocialMessage["kind"], string> = { comment: "commented", review: "reviewed", dm: "messaged", mention: "mentioned you" };

/** The inbox as conversations: comments under the post they answer, messages by person, and reviews. */
export function InboxThreads({ report, compact }: { report: SocialReport; compact?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const visible = report.inbox.filter((m) => m.intent !== "spam" && (showAll || m.status === "open"));
  const spam = report.inbox.filter((m) => m.intent === "spam").length;
  const groups = new Map<string, { title: string; items: SocialMessage[] }>();
  for (const m of [...visible].sort((a, b) => (a.at < b.at ? 1 : -1))) {
    const post = m.postId ? report.posts.find((p) => p.id === m.postId) : undefined;
    const key = post ? `post:${post.id}` : m.kind === "review" ? "reviews" : `person:${m.channelId}:${m.author}`;
    const title = post ? `Under "${post.topic}"` : m.kind === "review" ? "Reviews" : `${m.author} on ${m.platform}`;
    groups.set(key, { title, items: [...(groups.get(key)?.items ?? []), m] });
  }
  const open = report.inbox.filter((m) => m.status === "open" && m.intent !== "spam").length;
  return (
    <Section
      title={`Messages and reviews (${open} waiting)`}
      aside={
        <span className="muted">
          Rating {report.ratings.average} of 5 from {count(report.ratings.count, "review")}
          {compact ? null : (
            <>
              {". "}
              <button type="button" className="btn-link" onClick={() => setShowAll((x) => !x)}>
                {showAll ? "Waiting only" : "Show replied too"}
              </button>
            </>
          )}
        </span>
      }
    >
      {spam ? <p className="section-lede">{`${count(spam, "spam comment")} left unanswered.`}</p> : null}
      {[...groups.values()].map((g) => (
        <div className="thread" key={g.title}>
          <h3 className="thread-title">{g.title}</h3>
          <ul className="messages">
            {g.items.map((m) => (
              <li key={m.id} className={`message message-${m.sentiment}`}>
                <p className="message-meta">
                  <strong>{m.author}</strong> {KIND[m.kind]} on {m.platform}
                  {m.rating ? `, ${m.rating} of 5` : ""} <span className="muted num">{shortDate(m.at)}</span>
                </p>
                <p>{m.text}</p>
                {m.leadId ? (
                  <p className="message-handoff">
                    <Link to="/boardroom/$team/$tab" params={{ team: "sales", tab: "pipeline" }}>
                      Passed to the Sales Rep
                    </Link>{" "}
                    as a lead
                  </p>
                ) : null}
                {m.replyBy && m.status === "open" ? (
                  <p className="message-window muted">
                    WhatsApp allows a free reply until {new Date(m.replyBy).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}.
                  </p>
                ) : null}
                {m.draftReply ? (
                  <p className="message-reply">
                    <span className="muted">{m.status === "replied" ? "Replied: " : "Drafted reply: "}</span>
                    {m.draftReply}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {!groups.size ? <p className="section-lede">Nothing waiting. New comments, messages and reviews arrive here with a reply drafted.</p> : null}
    </Section>
  );
}

export function SocialInboxView({ report, compact }: { report: SocialReport; compact?: boolean }) {
  return (
    <>
      {compact ? null : <CoveringNote note={report.note} from="From the Social Media Manager" />}
      <InboxThreads report={report} compact={compact} />
    </>
  );
}

const POST = { draft: "Draft", scheduled: "Scheduled", published: "Published" } as const;
const totalViews = (p: Post) => p.variants.reduce((a, v) => a + (v.metrics?.views ?? 0), 0);
const channelsOf = (p: Post) => p.variants.filter((v) => v.status !== "skipped").map((v) => PLATFORM_NAMES[v.platform]).join(", ");

export function PostsView({ report }: { report: SocialReport }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = report.posts.find((p) => p.id === openId);
  return (
    <Section title="Posts">
      <LedgerTable
        caption="Posts"
        rows={report.posts}
        rowKey={(r) => r.id}
        initialSort={{ id: "a", desc: true }}
        rowTone={(r) => ((report.checks[r.id] ?? []).some((c) => !c.ok) ? "red" : undefined)}
        columns={[
          { id: "a", header: "When", cell: (r) => `${shortDate(r.at)}, ${r.at.slice(11, 16)}`, sortBy: (r) => r.at },
          { id: "t", header: "Post", cell: (r) => <button type="button" className="btn-link" onClick={() => setOpenId(r.id === openId ? null : r.id)} aria-expanded={r.id === openId}>{r.topic}</button>, sortBy: (r) => r.topic },
          { id: "p", header: "Where", cell: channelsOf, secondary: true },
          { id: "s", header: "Status", cell: (r) => POST[r.status], sortBy: (r) => r.status },
          { id: "v", header: "Views", cell: (r) => (totalViews(r) ? totalViews(r).toLocaleString("en-IN") : ""), sortBy: totalViews, numeric: true, secondary: true },
        ]}
      />
      {opened ? <PostCard post={opened} report={report} editable={isOwner()} /> : null}
    </Section>
  );
}

export function CalendarView({ report }: { report: SocialReport }) {
  const marketing = useQuery(q.marketing());
  const cals = report.calendars.filter((c) => c.status !== "superseded").sort((a, b) => (a.month < b.month ? 1 : -1));
  return (
    <Section title="Content calendar">
      <p className="section-lede">One block per planned post, hatched by its pillar. An approved month lets a trusted Social Media Manager publish each post at its time, if it is unchanged and passes every check again then.</p>
      {cals.map((c) => (
        <CalendarGrid key={c.id} calendar={c} pillars={report.voice.pillars} posts={report.posts} festivals={marketing.data?.calendar} />
      ))}
    </Section>
  );
}

/** Results by channel and pillar, the funnel to invoices, the best posts and the next thing to try. */
export function SocialResultsView({ report }: { report: SocialReport }) {
  const p = report.performance;
  const f = p.funnel;
  const post = (id: string) => report.posts.find((x) => x.id === id);
  return (
    <>
      <CoveringNote note={report.note} from="From the Social Media Manager" />
      <Section title="From post to invoice">
        <dl className="register funnel">
          <div>
            <dt>Posts published</dt>
            <dd>{f.posts}</dd>
          </div>
          <div>
            <dt>Views</dt>
            <dd className="num">{f.views.toLocaleString("en-IN")}</dd>
          </div>
          <div>
            <dt>Link clicks</dt>
            <dd className="num">{f.clicks.toLocaleString("en-IN")}</dd>
          </div>
          <div>
            <dt>Enquiries</dt>
            <dd>{f.enquiries}</dd>
          </div>
          <div>
            <dt>Leads</dt>
            <dd>
              <Link to="/boardroom/$team/$tab" params={{ team: "sales", tab: "pipeline" }}>
                {f.leads}
              </Link>
            </dd>
          </div>
          <div>
            <dt>Quotations</dt>
            <dd>
              <Link to="/boardroom/$team/$tab" params={{ team: "sales", tab: "quotes" }}>
                {f.quotes}
              </Link>
            </dd>
          </div>
          <div>
            <dt>Invoiced since</dt>
            <dd>
              <Figure figureId="social:invoiced" tone="green" label="Invoiced to customers who came from social media">
                <Amount paise={f.invoicedPaise} short />
              </Figure>
            </dd>
          </div>
        </dl>
        <p className="table-note muted">
          A lead counts when it came from a social channel or from a message the Social Media Manager passed on. Invoices count from the day the customer first got in touch
          {f.partyIds.length ? (
            <>
              {": "}
              {f.partyIds.map((id, i) => (
                <span key={id}>
                  {i ? ", " : ""}
                  <Link to="/parties/$partyId" params={{ partyId: id }}>
                    {id}
                  </Link>
                </span>
              ))}
            </>
          ) : null}
          .
        </p>
      </Section>
      <Section title="By channel">
        <LedgerTable
          caption="Results by channel"
          rows={p.byChannel}
          rowKey={(r) => r.channelId}
          initialSort={{ id: "v", desc: true }}
          columns={[
            { id: "c", header: "Channel", cell: (r) => PLATFORM_NAMES[r.platform], sortBy: (r) => r.platform },
            { id: "p", header: "Posts", cell: (r) => r.posts, numeric: true, secondary: true },
            { id: "v", header: "Views", cell: (r) => r.views.toLocaleString("en-IN"), sortBy: (r) => r.views, numeric: true },
            { id: "e", header: "Engaged", cell: (r) => pct(r.rate), sortBy: (r) => r.rate, numeric: true },
            { id: "q", header: "Enquiries", cell: (r) => r.enquiries, sortBy: (r) => r.enquiries, numeric: true },
          ]}
        />
      </Section>
      <Section title="By pillar">
        <LedgerTable
          caption="Results by pillar"
          rows={p.byPillar}
          rowKey={(r) => r.pillarId}
          columns={[
            { id: "n", header: "Pillar", cell: (r) => r.name },
            { id: "p", header: "Posts", cell: (r) => r.posts, numeric: true, secondary: true },
            { id: "v", header: "Views", cell: (r) => r.views.toLocaleString("en-IN"), numeric: true },
            { id: "e", header: "Engaged", cell: (r) => (r.posts ? pct(r.rate) : ""), sortBy: (r) => r.rate, numeric: true },
          ]}
        />
      </Section>
      <Section title="What worked">
        <ul className="digest">
          {p.best.map((b) => (
            <li key={b.postId + b.channelId}>
              <span>{post(b.postId)?.topic ?? b.postId}</span>
              <span className="muted">{b.reason}</span>
            </li>
          ))}
        </ul>
        <p className="experiment">
          <strong>Try next month.</strong> {p.experiment}
        </p>
      </Section>
      {isOwner() ? <MetricsImport /> : null}
    </>
  );
}

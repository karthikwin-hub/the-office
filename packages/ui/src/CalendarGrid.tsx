import type { ContentCalendar, Pillar, Post } from "@office/contracts";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const POST_STATE: Record<Post["status"], string> = { draft: "Draft", scheduled: "Scheduled", published: "Published" };

type Props = {
  calendar: ContentCalendar;
  pillars: Pillar[];
  posts?: Post[];
  festivals?: { date: string; name: string }[];
  onOpen?: (postId: string) => void;
};

const dayOf = (iso: string) => Number(iso.slice(8, 10));

/**
 * The month drawn as a plan: one bay per day, each planned post a block hatched by its pillar,
 * so the mix of the month can be read at a glance without relying on colour.
 */
export function CalendarGrid({ calendar, pillars, posts = [], festivals = [], onOpen }: Props) {
  const [y, m] = calendar.month.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: (number | null)[] = [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
  const pillarIndex = new Map(pillars.map((p, i) => [p.id, i % 4]));
  const byId = new Map(posts.map((p) => [p.id, p]));
  const label = first.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  const status = calendar.status === "approved" ? `Approved${calendar.approvedBy ? ` by ${calendar.approvedBy}` : ""}` : calendar.status === "draft" ? "Waiting for your approval" : "Replaced";

  return (
    <figure className="calendar">
      <figcaption className="calendar-head">
        <strong>{label}</strong> <span className="muted">{`${calendar.slots.length} posts. ${status}.`}</span>
      </figcaption>
      <table className="calendar-grid">
        <thead>
          <tr>
            {WEEKDAYS.map((d) => (
              <th key={d} scope="col">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((w, wi) => (
            <tr key={wi}>
              {w.map((d, di) => {
                if (d === null) return <td key={di} className="calendar-blank" aria-hidden="true" />;
                const iso = `${calendar.month}-${String(d).padStart(2, "0")}`;
                const slots = calendar.slots.filter((s) => dayOf(s.date) === d);
                const fest = festivals.filter((f) => f.date === iso);
                return (
                  <td key={di} className={slots.length ? "calendar-day has-slot" : "calendar-day"}>
                    <span className="calendar-date num">
                      {new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })}
                    </span>
                    {fest.map((f) => (
                      <span key={f.name} className="calendar-festival">
                        {f.name}
                      </span>
                    ))}
                    {slots.map((s, si) => {
                      const post = s.postId ? byId.get(s.postId) : undefined;
                      const state = post ? POST_STATE[post.status] : "Not drafted yet";
                      const body = (
                        <>
                          <span className="calendar-topic">{s.topic}</span>
                          <span className="calendar-state">
                            {state}, {s.channelIds.length} {s.channelIds.length === 1 ? "channel" : "channels"}
                          </span>
                        </>
                      );
                      return (
                        <div key={si} className={`calendar-slot pillar-${pillarIndex.get(s.pillarId) ?? 0} slot-${post?.status ?? "empty"}`}>
                          {post && onOpen ? (
                            <button type="button" className="calendar-open" onClick={() => onOpen(post.id)}>
                              {body}
                            </button>
                          ) : (
                            body
                          )}
                        </div>
                      );
                    })}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="calendar-key" aria-label="Pillars">
        {pillars.map((p, i) => (
          <li key={p.id}>
            <span className={`calendar-swatch pillar-${i % 4}`} aria-hidden="true" />
            {p.name}
            <span className="muted num">
              {` ${calendar.slots.filter((s) => s.pillarId === p.id).length} of ${calendar.slots.length}, aim ${p.share}%`}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

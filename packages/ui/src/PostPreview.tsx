import type { Channel, MediaAsset, PostCheck, PostFact, PostVariant } from "@office/contracts";
import { PLATFORM_NAMES } from "@office/contracts";
import { charCount, RULES, segmentFigures } from "@office/engine";
import { useId, useState } from "react";
import { useFigures } from "./Figure";

const STATUS: Record<PostVariant["status"], string> = { draft: "Draft", scheduled: "Scheduled", published: "Published", failed: "Failed", skipped: "Left out" };

type Props = {
  variant: PostVariant;
  channel?: Channel;
  facts: PostFact[];
  media: MediaAsset[];
  /** Checks for the whole post; the ones for this channel and the shared ones are shown. */
  checks?: PostCheck[];
  at?: string;
  onSave?: (text: string) => void;
  busy?: boolean;
};

/** Where a fact's source opens: the SKU's price and stock, or the campaign. */
const factFigure = (f: PostFact) => (f.ref.kind === "sku" || f.ref.kind === "stock" ? `sku:${f.ref.id}` : null);

/**
 * One channel's version of a post, as a carbon copy of what will go out: the text with every figure
 * linked to where it comes from, the pictures with their descriptions, and a meter against the
 * channel's length limit.
 */
export function PostPreview({ variant: v, channel, facts, media, checks = [], at, onSave, busy }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(v.text);
  const { open } = useFigures();
  const id = useId();
  const rules = RULES[v.platform];
  const text = editing ? draft : v.text;
  const n = charCount(v.platform, text);
  const over = n > rules.maxChars;
  const mine = checks.filter((c) => c.channelId === v.channelId && !c.ok);
  const pics = v.mediaIds.map((mid) => media.find((m) => m.id === mid)).filter((m): m is MediaAsset => !!m);
  const when = v.publishedAt ?? at;

  return (
    <article className={`post-copy post-copy-${v.status}`} aria-labelledby={`${id}-ch`}>
      <header className="post-copy-head">
        <h4 id={`${id}-ch`} className="post-copy-channel">
          {PLATFORM_NAMES[v.platform]}
          {channel?.handle ? <span className="muted"> {channel.handle}</span> : null}
        </h4>
        <span className="post-copy-status">
          {STATUS[v.status]}
          {when ? <time dateTime={when}>{` ${new Date(when).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}`}</time> : null}
        </span>
      </header>
      {pics.length ? (
        <ul className="post-copy-media" aria-label="Pictures">
          {pics.map((m) => (
            <li key={m.id}>
              <img src={m.url} alt={m.alt} width={96} height={96} loading="lazy" />
              <span className={m.alt ? "muted" : "figure-red"}>{m.alt || "No description for screen readers"}</span>
              {m.rights === "generated" ? <span className="muted">Generated picture</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {editing ? (
        <form
          className="post-copy-edit"
          onSubmit={(e) => {
            e.preventDefault();
            onSave?.(draft);
            setEditing(false);
          }}
        >
          <label htmlFor={`${id}-text`} className="visually-hidden">
            Text for {PLATFORM_NAMES[v.platform]}
          </label>
          <textarea id={`${id}-text`} className="input" rows={Math.min(14, draft.split("\n").length + 3)} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="approval-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || over || !draft.trim()}>
              Save for {PLATFORM_NAMES[v.platform]}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => (setEditing(false), setDraft(v.text))}>
              Discard changes
            </button>
          </div>
        </form>
      ) : (
        <p className="post-copy-text">
          {segmentFigures(v.text, facts).map((s, i) =>
            !s.figure ? (
              <span key={i}>{s.text}</span>
            ) : s.fact && factFigure(s.fact) ? (
              <button key={i} type="button" className="figure figure-link" onClick={() => open(factFigure(s.fact!)!)} aria-label={`${s.text}: ${s.fact.label}. Show where this comes from`}>
                {s.text}
              </button>
            ) : s.fact ? (
              <span key={i} className="figure" title={s.fact.label}>
                {s.text}
              </span>
            ) : (
              <mark key={i} className="post-copy-unmatched" title="Not found in the books">
                {s.text}
              </mark>
            ),
          )}
        </p>
      )}
      <div className="post-copy-meter" role="meter" aria-valuemin={0} aria-valuemax={rules.maxChars} aria-valuenow={n} aria-label={`Length for ${PLATFORM_NAMES[v.platform]}`}>
        <span className={over ? "is-over" : undefined} style={{ inlineSize: `${Math.min(100, (n / rules.maxChars) * 100)}%` }} />
      </div>
      <p className="post-copy-foot">
        <span className={`num${over ? " figure-red" : ""}`}>
          {n.toLocaleString("en-IN")} of {rules.maxChars.toLocaleString("en-IN")} characters
        </span>
        {v.url ? (
          <a href={v.url} target="_blank" rel="noreferrer">
            Open the post
          </a>
        ) : null}
        {onSave && !editing && v.status !== "published" ? (
          <button type="button" className="btn-link" onClick={() => setEditing(true)}>
            Edit for this channel
          </button>
        ) : null}
      </p>
      {v.error && v.status !== "published" ? <p className="post-copy-note">{v.error}</p> : null}
      {mine.length ? (
        <ul className="post-copy-checks">
          {mine.map((c) => (
            <li key={c.key + c.detail}>{c.detail}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

/** A post's shared checks: prices, stock, dates and claims, which apply to every channel. */
export function PostChecks({ checks }: { checks: PostCheck[] }) {
  const shared = checks.filter((c) => c.channelId === null);
  if (!shared.length) return null;
  return (
    <ul className="post-checks" aria-label="Checks">
      {shared.map((c, i) => (
        <li key={i} className={c.ok ? "is-ok" : "is-failed"}>
          <span className="post-checks-label">{c.label}</span> {c.detail}
        </li>
      ))}
    </ul>
  );
}

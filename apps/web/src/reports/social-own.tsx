import type { OwnerPost, OwnerPostResult, Post, SocialReport } from "@office/contracts";
import { PLATFORM_NAMES } from "@office/contracts";
import { readPostSheet, SHEET_TEMPLATE, sheetPosts } from "@office/engine";
import { useId, useState } from "react";
import { api } from "../api/client";
import { useSocial } from "../api/queries";
import { longDate, Section } from "../screens/common";

/** Instagram takes a video as a Reel and Facebook as a Page video; the other channels' posting code does not take one yet. */
const TAKES_VIDEO = new Set(["instagram", "facebook"]);
/** A `datetime-local` value, read as India time. */
const fromLocal = (v: string) => (v ? `${v}:00+05:30` : null);
const when = (p: Post) => `${longDate(p.at)}, ${p.at.slice(11, 16)}`;

async function upload(file: File, alt: string) {
  const form = new FormData();
  form.set("file", file);
  form.set("alt", alt.slice(0, 500));
  form.set("rights", "own");
  return api.uploadMedia(form);
}

/** What the checks found, and the way to go ahead anyway: the owner wrote it, so it is their call. */
function Warnings({ result, busy, onConfirm }: { result: OwnerPostResult; busy: boolean; onConfirm: () => void }) {
  const many = result.posts.length > 1;
  return (
    <div className="covering-note" role="alert">
      <p>
        <strong>Check before scheduling.</strong> The checks found:
      </p>
      <ul>
        {result.warnings.map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: warnings have no id and never reorder.
          <li key={i}>
            {many ? `Post ${w.row}: ` : ""}
            {w.detail}
          </li>
        ))}
      </ul>
      <button type="button" className="btn" disabled={busy} onClick={onConfirm}>
        Schedule anyway
      </button>
    </div>
  );
}

/** One post the owner wrote: caption, pictures or a video, channels and a time, or the next free day. */
export function OwnPostComposer({ report }: { report: SocialReport }) {
  const social = useSocial();
  const id = useId();
  const usable = report.channels.filter((c) => c.platform !== "google");
  const [text, setText] = useState("");
  const [alt, setAlt] = useState("");
  const [channelIds, setChannelIds] = useState<string[]>(usable.filter((c) => c.platform === "instagram" || c.platform === "facebook").map((c) => c.id));
  const [files, setFiles] = useState<File[]>([]);
  const [at, setAt] = useState("");
  const [uploaded, setUploaded] = useState<string[] | null>(null);
  const [result, setResult] = useState<OwnerPostResult | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const video = files.some((f) => f.type.startsWith("video/"));
  const noVideo = video ? usable.filter((c) => channelIds.includes(c.id) && !TAKES_VIDEO.has(c.platform)) : [];

  const send = (confirm: boolean) =>
    social.mutate(
      async () => {
        const mediaIds = uploaded ?? [];
        if (!uploaded) {
          for (const f of files) mediaIds.push((await upload(f, alt)).id);
          setUploaded(mediaIds);
        }
        const post: OwnerPost = { text, channelIds, versions: [], mediaIds, link: null, skuIds: [], at: fromLocal(at) };
        return api.ownPosts({ posts: [post], confirm });
      },
      {
        onSuccess: (r) => {
          const res = r as OwnerPostResult;
          if (!res.saved) return setResult(res);
          setDone(`Scheduled for ${when(res.posts[0]!)}. You can change each channel's version in the list below until it goes out.`);
          setText("");
          setAlt("");
          setFiles([]);
          setAt("");
          setUploaded(null);
          setResult(null);
        },
      },
    );

  return (
    <Section title="Post something of your own">
      <p className="section-lede">
        Write it once and pick the channels. It goes out at your time, or on each channel's next free day, with nothing to approve. Prices and stock are still
        checked against the books, and you decide.
      </p>
      <form
        className="settings-grid"
        onSubmit={(e) => {
          e.preventDefault();
          setDone(null);
          send(false);
        }}
      >
        <div className="field field-wide">
          <label htmlFor={`${id}-text`}>Caption</label>
          <textarea
            id={`${id}-text`}
            className="input"
            rows={5}
            required
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setResult(null);
            }}
          />
        </div>
        <fieldset className="field">
          <legend>Channels</legend>
          {usable.map((c) => (
            <label key={c.id}>
              <input
                type="checkbox"
                checked={channelIds.includes(c.id)}
                onChange={(e) => {
                  setChannelIds(e.target.checked ? [...channelIds, c.id] : channelIds.filter((x) => x !== c.id));
                  setResult(null);
                }}
              />{" "}
              {PLATFORM_NAMES[c.platform]}
              {c.mode === "manual" ? <span className="muted"> (by hand)</span> : null}
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor={`${id}-files`}>Pictures or a video</label>
          <input
            id={`${id}-files`}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime"
            onChange={(e) => {
              setFiles([...(e.target.files ?? [])].slice(0, 10));
              setUploaded(null);
              setResult(null);
            }}
          />
          <span className="muted">Up to 10 pictures (8 MB each) or a video up to 25 MB. Instagram needs at least one.</span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-alt`}>Describe the picture</label>
          <input id={`${id}-alt`} className="input" value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="For people who can't see it" />
        </div>
        <div className="field">
          <label htmlFor={`${id}-at`}>When</label>
          <input id={`${id}-at`} className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          <span className="muted">Leave empty for the next free day.</span>
        </div>
        {noVideo.length ? (
          <p className="form-error">Videos go to Instagram and Facebook only for now; untick {noVideo.map((c) => PLATFORM_NAMES[c.platform]).join(", ")}.</p>
        ) : null}
        <div className="field field-wide">
          <button type="submit" className="btn btn-primary" disabled={social.isPending || !text.trim() || !channelIds.length || noVideo.length > 0}>
            {social.isPending ? "Scheduling" : "Schedule"}
          </button>
        </div>
      </form>
      {result ? <Warnings result={result} busy={social.isPending} onConfirm={() => send(true)} /> : null}
      {done ? <p role="status">{done}</p> : null}
      {social.error ? <p className="form-error">{(social.error as Error).message}</p> : null}
    </Section>
  );
}

/** A month of the owner's posts at once: a sheet of dates, channels and captions, with the pictures it names. */
export function OwnPostSheet({ report }: { report: SocialReport }) {
  const social = useSocial();
  const id = useId();
  const [sheet, setSheet] = useState<File | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [posts, setPosts] = useState<OwnerPost[] | null>(null);
  const [result, setResult] = useState<OwnerPostResult | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(SHEET_TEMPLATE)}`;

  const send = (confirm: boolean) =>
    social.mutate(
      async () => {
        let ready = posts;
        if (!ready) {
          if (!sheet) throw new Error("Choose the sheet.");
          const read = readPostSheet(await sheet.text(), report.channels);
          const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
          const missing = [...new Set(read.rows.flatMap((r) => r.files))].filter((n) => !byName.has(n.toLowerCase()));
          const problems = [...read.errors, ...missing.map((n) => `Attach ${n}: the sheet names it.`)];
          setErrors(problems);
          if (problems.length) return null;
          const ids = new Map<string, string>();
          for (const name of new Set(read.rows.flatMap((r) => r.files.map((f) => f.toLowerCase())))) ids.set(name, (await upload(byName.get(name)!, "")).id);
          ready = sheetPosts(read.rows, ids);
          setPosts(ready);
        }
        return api.ownPosts({ posts: ready, confirm });
      },
      {
        onSuccess: (r) => {
          const res = r as OwnerPostResult | null;
          if (!res) return;
          if (!res.saved) return setResult(res);
          setDone(`Scheduled ${res.posts.length} ${res.posts.length === 1 ? "post" : "posts"}, the first on ${when(res.posts[0]!)}.`);
          setSheet(null);
          setFiles([]);
          setPosts(null);
          setResult(null);
        },
      },
    );

  return (
    <details className="frame-maker">
      <summary>Schedule a month of posts from a sheet</summary>
      <p className="section-lede">
        One row per post: the date, the time (or leave it empty for 11:00), the channels by name, the caption and the file names of its pictures or video.{" "}
        <a href={template} download="posts-template.csv">
          Download the template
        </a>
        .
      </p>
      <div className="settings-grid">
        <div className="field">
          <label htmlFor={`${id}-sheet`}>The sheet (CSV)</label>
          <input
            id={`${id}-sheet`}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              setSheet(e.target.files?.[0] ?? null);
              setPosts(null);
              setResult(null);
              setErrors([]);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-media`}>Its pictures and videos</label>
          <input
            id={`${id}-media`}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime"
            onChange={(e) => {
              setFiles([...(e.target.files ?? [])]);
              setPosts(null);
              setResult(null);
              setErrors([]);
            }}
          />
        </div>
        <div className="field field-wide">
          <button
            type="button"
            className="btn btn-primary"
            disabled={social.isPending || !sheet}
            onClick={() => {
              setDone(null);
              send(false);
            }}
          >
            {social.isPending ? "Scheduling" : "Schedule the sheet"}
          </button>
        </div>
      </div>
      {errors.length ? (
        <ul className="form-error" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {result ? <Warnings result={result} busy={social.isPending} onConfirm={() => send(true)} /> : null}
      {done ? <p role="status">{done}</p> : null}
      {social.error ? <p className="form-error">{(social.error as Error).message}</p> : null}
    </details>
  );
}

/** Moving or removing one of the owner's posts before it goes out. */
export function OwnPostActions({ post }: { post: Post }) {
  const social = useSocial();
  const id = useId();
  const [at, setAt] = useState(post.at.slice(0, 16));
  if (post.source !== "owner" || post.variants.some((v) => v.status === "published")) return null;
  return (
    <div className="own-post-actions">
      <div className="field">
        <label htmlFor={`${id}-at`}>Move to</label>
        <input id={`${id}-at`} className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
      </div>
      <button
        type="button"
        className="btn"
        disabled={social.isPending || at === post.at.slice(0, 16)}
        onClick={() => social.mutate(() => api.movePost(post.id, fromLocal(at)!))}
      >
        Move
      </button>
      <button type="button" className="btn btn-link" disabled={social.isPending} onClick={() => social.mutate(() => api.removePost(post.id))}>
        Remove before it goes out
      </button>
      {social.error ? <p className="form-error">{(social.error as Error).message}</p> : null}
    </div>
  );
}

/** The agent's post on its way out can be stopped; a live version can be taken down. Either costs the agent a trust level. */
export function AgentPostActions({ post }: { post: Post }) {
  const social = useSocial();
  const [note, setNote] = useState<string | null>(null);
  if (post.source === "owner") return null;
  const waiting = post.status === "scheduled" && post.variants.some((v) => v.status === "scheduled");
  const live = post.variants.filter((v) => v.status === "published");
  if (!waiting && !live.length) return null;
  return (
    <div className="own-post-actions">
      {waiting ? (
        <button type="button" className="btn" disabled={social.isPending} onClick={() => social.mutate(() => api.stopPost(post.id))}>
          Stop it before it goes out
        </button>
      ) : null}
      {live.map((v) => (
        <button
          key={v.channelId}
          type="button"
          className="btn btn-link"
          disabled={social.isPending}
          onClick={() =>
            social.mutate(() => api.takeDown(post.id, v.channelId), {
              onSuccess: (r) =>
                setNote(
                  (r as { byHand: boolean }).byHand
                    ? `${PLATFORM_NAMES[v.platform]} does not let apps delete posts: delete it in the ${PLATFORM_NAMES[v.platform]} app. It is marked as taken down here.`
                    : `Taken down from ${PLATFORM_NAMES[v.platform]}.`,
                ),
            })
          }
        >
          Take it down from {PLATFORM_NAMES[v.platform]}
        </button>
      ))}
      {post.approvedBy === "agent" ? <span className="muted">The agent posted this on its own; stopping it moves the agent back a trust level.</span> : null}
      {note ? <p role="status">{note}</p> : null}
      {social.error ? <p className="form-error">{(social.error as Error).message}</p> : null}
    </div>
  );
}

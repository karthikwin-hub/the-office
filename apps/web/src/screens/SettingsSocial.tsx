import type { BrandVoice, Channel, FestivalDate, Language, SocialReport } from "@office/contracts";
import { INDIA_FESTIVALS, PLATFORM_NAMES } from "@office/contracts";
import { ChannelStrip } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { api, isLive } from "../api/client";
import { q, useSocial } from "../api/queries";
import { isOwner, Section } from "./common";

const LANGUAGES: Record<Language, string> = { en: "English", hi: "Hindi", mr: "Marathi" };
const EMOJI = { none: "None", light: "One or two where they help", free: "As the platform likes" } as const;
const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

/** Channels and brand voice, shown once the Social Media Manager has a report to read them from. */
export function SocialSettings() {
  const social = useQuery(q.social());
  if (!social.data) return null;
  return (
    <>
      <ChannelsSection report={social.data} />
      <VoiceForm voice={social.data.voice} />
      <FestivalsForm chosen={social.data.festivals} />
    </>
  );
}

function ChannelsSection({ report }: { report: SocialReport }) {
  const owner = isOwner();
  const social = useSocial();
  const params = new URLSearchParams(location.search);
  const returned = params.get("connected");
  const failed = params.get("connect_error");
  return (
    <Section id="channels" title="Channels">
      <p className="section-lede">
        Connected channels publish on schedule and bring comments and messages to the Social Media Manager. Any channel can go out by hand instead: you get the
        text and pictures ready to paste, and mark it posted.
        {isLive ? " Connecting takes you to the platform to sign in, and back here." : ""}
      </p>
      {returned ? <p role="status">{PLATFORM_NAMES[returned as Channel["platform"]] ?? returned} is connected.</p> : null}
      {failed ? <p className="form-error">The platform did not connect: {failed}</p> : null}
      <ChannelStrip
        channels={report.channels}
        busy={social.isPending}
        onConnect={owner ? (c) => social.mutate(() => api.connectChannel(c.platform)) : undefined}
        onManual={owner ? (c) => social.mutate(() => api.setupChannel(c.id, { mode: "manual" })) : undefined}
      />
      {social.error ? <p className="form-error">{(social.error as Error).message}</p> : null}
      {owner ? (
        <details className="channel-details">
          <summary>Handles and posting hours</summary>
          <ul className="channel-forms">
            {report.channels.map((c) => (
              <ChannelForm key={c.id} c={c} />
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}

function ChannelForm({ c }: { c: Channel }) {
  const [handle, setHandle] = useState(c.handle);
  const [from, setFrom] = useState(c.postingHours.from);
  const [to, setTo] = useState(c.postingHours.to);
  const [saved, setSaved] = useState(false);
  const social = useSocial();
  const id = useId();
  const valid = handle.trim() && from < to;
  return (
    <li>
      <form
        className="field-inline"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          social.mutate(() => api.setupChannel(c.id, { handle: handle.trim(), postingHours: { from, to } }), { onSuccess: () => setSaved(true) });
        }}
      >
        <strong className="channel-form-name">{PLATFORM_NAMES[c.platform]}</strong>
        <label htmlFor={`${id}-h`}>Handle</label>
        <input id={`${id}-h`} className="input" value={handle} onChange={(e) => setHandle(e.target.value)} />
        <label htmlFor={`${id}-f`}>Posts between</label>
        <input id={`${id}-f`} className="input num" type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
        <label htmlFor={`${id}-t`}>and</label>
        <input id={`${id}-t`} className="input num" type="time" value={to} onChange={(e) => setTo(e.target.value)} />
        <button type="submit" className="btn" disabled={!valid || social.isPending}>
          Save
        </button>
        {saved ? <span role="status">Saved</span> : null}
        {from >= to ? <span className="form-error">The start must be before the end.</span> : null}
      </form>
    </li>
  );
}

function VoiceForm({ voice }: { voice: BrandVoice }) {
  const owner = isOwner();
  const [v, setV] = useState(voice);
  const [dos, setDos] = useState(voice.dos.join("\n"));
  const [donts, setDonts] = useState(voice.donts.join("\n"));
  const [samples, setSamples] = useState(voice.samples.join("\n\n"));
  const [hashtags, setHashtags] = useState(voice.hashtags.join(" "));
  const [colours, setColours] = useState(voice.colours.join(" "));
  const [competitors, setCompetitors] = useState(voice.competitors.join("\n"));
  const [saved, setSaved] = useState(false);
  const colourList = colours.split(/[\s,]+/).filter(Boolean);
  const coloursOk = colourList.length <= 5 && colourList.every((c) => /^#[0-9a-fA-F]{6}$/.test(c));
  const social = useSocial();
  const total = v.pillars.reduce((s, p) => s + p.share, 0);
  const valid = total === 100 && v.languages.length > 0 && v.tone.trim().length > 0 && coloursOk;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const next: BrandVoice = {
      ...v,
      dos: lines(dos),
      donts: lines(donts),
      samples: samples
        .split(/\n\s*\n/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 10),
      hashtags: hashtags
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((h) => (h.startsWith("#") ? h : `#${h}`)),
      colours: colourList,
      competitors: lines(competitors).slice(0, 20),
    };
    social.mutate(() => api.saveVoice(next), { onSuccess: () => setSaved(true) });
  };
  return (
    <form onSubmit={submit} className="settings-form">
      <fieldset disabled={!owner}>
        <legend className="h2">How your posts sound</legend>
        <p className="section-lede">
          The Social Media Manager writes every draft to this. Paste a few posts you were happy with, and it will follow their length and manner.
        </p>
        <div className="settings-grid">
          <div className="field field-wide">
            <label htmlFor="tone">Tone</label>
            <input id="tone" className="input" value={v.tone} onChange={(e) => setV({ ...v, tone: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="dos">Always do (one per line)</label>
            <textarea id="dos" className="input" rows={4} value={dos} onChange={(e) => setDos(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="donts">Never do (one per line)</label>
            <textarea id="donts" className="input" rows={4} value={donts} onChange={(e) => setDonts(e.target.value)} />
          </div>
          <div className="field field-wide">
            <label htmlFor="samples">Past posts you liked (a blank line between each, up to five is plenty)</label>
            <textarea id="samples" className="input" rows={8} value={samples} onChange={(e) => setSamples(e.target.value)} />
          </div>
          <fieldset className="field">
            <legend>Languages</legend>
            {(Object.keys(LANGUAGES) as Language[]).map((l) => (
              <label key={l}>
                <input
                  type="checkbox"
                  checked={v.languages.includes(l)}
                  onChange={(e) => setV({ ...v, languages: e.target.checked ? [...v.languages, l] : v.languages.filter((x) => x !== l) })}
                />{" "}
                {LANGUAGES[l]}
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor="emoji">Emoji</label>
            <select id="emoji" className="input" value={v.emoji} onChange={(e) => setV({ ...v, emoji: e.target.value as BrandVoice["emoji"] })}>
              {(Object.keys(EMOJI) as BrandVoice["emoji"][]).map((k) => (
                <option key={k} value={k}>
                  {EMOJI[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="hashtags">Your hashtags</label>
            <input id="hashtags" className="input" value={hashtags} onChange={(e) => setHashtags(e.target.value)} />
          </div>
          <div className="field field-wide">
            <label htmlFor="audience">Who the posts are for</label>
            <input
              id="audience"
              className="input"
              value={v.audience}
              maxLength={500}
              placeholder="Electricians and homeowners in Pune who want safe, branded fittings"
              onChange={(e) => setV({ ...v, audience: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="competitors">Never mention (one per line)</label>
            <textarea id="competitors" className="input" rows={3} value={competitors} onChange={(e) => setCompetitors(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="image-style">How pictures should look</label>
            <input
              id="image-style"
              className="input"
              value={v.imageStyle}
              maxLength={500}
              placeholder="Bright, clean counter shots on white"
              onChange={(e) => setV({ ...v, imageStyle: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="colours">Brand colours</label>
            <input id="colours" className="input" value={colours} placeholder="#27408B #F3F5F7" onChange={(e) => setColours(e.target.value)} />
            {!coloursOk ? <span className="form-error">Up to five colours written like #27408B.</span> : null}
          </div>
          <div className="field">
            <label htmlFor="signoff">Sign-off</label>
            <input id="signoff" className="input" value={v.signoff} onChange={(e) => setV({ ...v, signoff: e.target.value })} />
          </div>
        </div>
        <fieldset className="pillar-shares">
          <legend>What the month's posts are about</legend>
          <ul>
            {v.pillars.map((p, i) => (
              <li key={p.id}>
                <span className={`pillar-swatch pillar-${i % 4}`} aria-hidden />
                <label htmlFor={`pillar-${p.id}`}>
                  <strong>{p.name}</strong> <span className="muted">{p.description}</span>
                </label>
                <div className="input-suffix">
                  <input
                    id={`pillar-${p.id}`}
                    className="input num"
                    type="number"
                    min={0}
                    max={100}
                    value={p.share}
                    onChange={(e) =>
                      setV({
                        ...v,
                        pillars: v.pillars.map((x) =>
                          x.id === p.id ? { ...x, share: Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))) } : x,
                        ),
                      })
                    }
                  />
                  <span>%</span>
                </div>
              </li>
            ))}
          </ul>
          {total !== 100 ? <p className="form-error">The shares add up to {total}%; they need to make 100%.</p> : null}
        </fieldset>
        <div className="approval-actions">
          <button type="submit" className="btn btn-primary" disabled={!valid || social.isPending}>
            Save brand voice
          </button>
          {saved ? <span role="status">Brand voice saved. Next month's calendar will follow it.</span> : null}
          {social.error ? <span className="form-error">{(social.error as Error).message}</span> : null}
        </div>
      </fieldset>
    </form>
  );
}

const festivalKey = (f: FestivalDate) => `${f.date}|${f.name}`;

/** Which festivals the agent plans posts for: the built-in list to tick, and the owner's own with their dates. */
function FestivalsForm({ chosen }: { chosen: FestivalDate[] }) {
  const owner = isOwner();
  const social = useSocial();
  const today = new Date().toISOString().slice(0, 10);
  const builtIn = INDIA_FESTIVALS.filter((f) => f.date >= today);
  const [on, setOn] = useState(() => new Set(chosen.map(festivalKey)));
  const [own, setOwn] = useState<FestivalDate[]>(() => chosen.filter((f) => !INDIA_FESTIVALS.some((b) => festivalKey(b) === festivalKey(f))));
  const [draft, setDraft] = useState({ date: "", name: "" });
  const [saved, setSaved] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const festivals = [...builtIn.filter((f) => on.has(festivalKey(f))), ...own];
    social.mutate(() => api.saveFestivals(festivals), { onSuccess: () => setSaved(true) });
  };
  return (
    <form onSubmit={submit} className="settings-form">
      <fieldset disabled={!owner}>
        <legend className="h2">Festivals to plan for</legend>
        <p className="section-lede">
          The Social Media Manager plans an offers post three days before each festival you tick. Dates that vary by region, such as Pongal, Ugadi, Onam and
          Dussehra, are yours to add with the date you keep.
        </p>
        <fieldset className="field">
          <legend>Built in</legend>
          <p>
            <button type="button" className="btn-link" onClick={() => setOn(new Set([...on, ...builtIn.map(festivalKey)]))}>
              Tick all
            </button>
          </p>
          {builtIn.map((f) => (
            <label key={festivalKey(f)}>
              <input
                type="checkbox"
                checked={on.has(festivalKey(f))}
                onChange={(e) => {
                  const next = new Set(on);
                  if (e.target.checked) next.add(festivalKey(f));
                  else next.delete(festivalKey(f));
                  setOn(next);
                }}
              />{" "}
              {f.name} <span className="muted">{new Date(f.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="field">
          <legend>Your own</legend>
          {own.map((f) => (
            <p key={festivalKey(f)}>
              {f.name} <span className="muted">{f.date}</span>{" "}
              <button type="button" className="btn-link" onClick={() => setOwn(own.filter((x) => festivalKey(x) !== festivalKey(f)))}>
                Remove
              </button>
            </p>
          ))}
          <div className="settings-grid">
            <div className="field">
              <label htmlFor="fest-name">Name</label>
              <input id="fest-name" className="input" value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="fest-date">Date</label>
              <input id="fest-date" className="input" type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
            </div>
          </div>
          <button
            type="button"
            className="btn"
            disabled={!draft.name.trim() || !draft.date}
            onClick={() => {
              setOwn([...own, { date: draft.date, name: draft.name.trim(), relevance: "Your own date" }]);
              setDraft({ date: "", name: "" });
            }}
          >
            Add
          </button>
        </fieldset>
        <div className="approval-actions">
          <button type="submit" className="btn btn-primary" disabled={social.isPending}>
            Save festivals
          </button>
          {saved ? <span role="status">Saved. Next month's calendar will plan for them.</span> : null}
          {social.error ? <span className="form-error">{(social.error as Error).message}</span> : null}
        </div>
      </fieldset>
    </form>
  );
}

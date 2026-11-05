import type { BrandVoice, Channel, Language, SocialReport } from "@office/contracts";
import { PLATFORM_NAMES } from "@office/contracts";
import { ChannelStrip } from "@office/ui";
import { useQuery } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { api, isLive } from "../api/client";
import { q, useSocial } from "../api/queries";
import { isOwner, Section } from "./common";

const LANGUAGES: Record<Language, string> = { en: "English", hi: "Hindi", mr: "Marathi" };
const EMOJI = { none: "None", light: "One or two where they help", free: "As the platform likes" } as const;
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

/** Channels and brand voice, shown once the Social Media Manager has a report to read them from. */
export function SocialSettings() {
  const social = useQuery(q.social());
  if (!social.data) return null;
  return (
    <>
      <ChannelsSection report={social.data} />
      <VoiceForm voice={social.data.voice} />
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
        Connected channels publish on schedule and bring comments and messages to the Social Media Manager. Any channel can go out by hand instead: you get the text and pictures ready to paste, and mark it posted.
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
  const [saved, setSaved] = useState(false);
  const social = useSocial();
  const total = v.pillars.reduce((s, p) => s + p.share, 0);
  const valid = total === 100 && v.languages.length > 0 && v.tone.trim().length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const next: BrandVoice = {
      ...v,
      dos: lines(dos),
      donts: lines(donts),
      samples: samples.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean).slice(0, 10),
      hashtags: hashtags.split(/[\s,]+/).filter(Boolean).map((h) => (h.startsWith("#") ? h : `#${h}`)),
    };
    social.mutate(() => api.saveVoice(next), { onSuccess: () => setSaved(true) });
  };
  return (
    <form onSubmit={submit} className="settings-form">
      <fieldset disabled={!owner}>
        <legend className="h2">How your posts sound</legend>
        <p className="section-lede">The Social Media Manager writes every draft to this. Paste a few posts you were happy with, and it will follow their length and manner.</p>
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
                <input type="checkbox" checked={v.languages.includes(l)} onChange={(e) => setV({ ...v, languages: e.target.checked ? [...v.languages, l] : v.languages.filter((x) => x !== l) })} /> {LANGUAGES[l]}
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
                    onChange={(e) => setV({ ...v, pillars: v.pillars.map((x) => (x.id === p.id ? { ...x, share: Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))) } : x)) })}
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

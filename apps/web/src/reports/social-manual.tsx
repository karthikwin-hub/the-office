import type { MediaAsset, Post, PostVariant, SocialReport } from "@office/contracts";
import { PLATFORM_NAMES } from "@office/contracts";
import { RULES } from "@office/engine";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api/client";
import { q, useSocial } from "../api/queries";
import { isOwner, Section, shortDate } from "../screens/common";

/** Copy, pictures and steps for a channel that is not connected, and the link back once it is posted. */
export function PublishingPackCard({ post, variant: v, report }: { post: Post; variant: PostVariant; report: SocialReport }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const pack = useQuery({ ...q.pack(post.id, v.channelId), enabled: open });
  const social = useSocial();
  const id = useId();
  const due = Date.parse(post.at) <= Date.now();
  const name = PLATFORM_NAMES[v.platform];
  return (
    <details className="pack" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <strong>{post.topic}</strong> on {name}, {`${shortDate(post.at)} ${post.at.slice(11, 16)}`}
        {due ? <span className="figure-red"> Due now</span> : null}
        {v.error ? <span className="muted">{`. ${v.error}`}</span> : null}
      </summary>
      {pack.data ? (
        <div className="pack-body">
          <ol className="pack-steps">
            {pack.data.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <div className="pack-text">
            <p className="approval-body">{pack.data.text}</p>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void navigator.clipboard.writeText(pack.data.text).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                })
              }
            >
              {copied ? "Copied" : "Copy text"}
            </button>
          </div>
          {pack.data.media.length ? (
            <ul className="pack-media">
              {pack.data.media.map((m) => (
                <li key={m.id}>
                  <img src={m.url} alt={m.alt} width={120} height={120} />
                  <a href={m.url} download={`${post.id}-${m.id}`}>
                    Save picture
                  </a>
                  {m.alt ? <span className="muted">Description: {m.alt}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {isOwner() ? (
            <form
              className="pack-posted"
              onSubmit={(e) => {
                e.preventDefault();
                social.mutate(() => api.markPosted(post.id, v.channelId, url.trim()));
              }}
            >
              <div className="field">
                <label htmlFor={`${id}-url`}>Link to the post on {name}</label>
                <input id={`${id}-url`} className="input" type="url" required placeholder={v.platform === "threads" ? "https://www.threads.net/@…/post/…" : "https://…"} value={url} onChange={(e) => setUrl(e.target.value)} />
              </div>
              <button type="submit" className="btn btn-primary" disabled={social.isPending || !url.trim()}>
                Mark as posted
              </button>
              {social.error ? <p className="form-error">{(social.error as Error).message}</p> : null}
            </form>
          ) : null}
        </div>
      ) : open ? (
        <p className="loading">Putting the pack together</p>
      ) : null}
    </details>
  );
}

/** A post-level export from Instagram, Facebook, LinkedIn or X, matched to posts by their links. */
export function MetricsImport() {
  const social = useSocial();
  const [result, setResult] = useState<string | null>(null);
  const id = useId();
  return (
    <Section title="Add results from a platform export">
      <p className="section-lede">For channels that are not connected, export post results as CSV from the platform's insights page. Rows are matched to posts by the link you pasted at Mark as posted.</p>
      <div className="field">
        <label htmlFor={id}>Results file (CSV)</label>
        <input
          id={id}
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setResult(null);
            const content = await file.text();
            social.mutate(() => api.importMetrics(content), {
              onSuccess: (r) => {
                const x = r as { matched: number; unmatched: number };
                setResult(`Added results for ${x.matched} ${x.matched === 1 ? "post" : "posts"}${x.unmatched ? `. ${x.unmatched} rows matched no post: check that each was marked as posted with its link.` : "."}`);
              },
            });
            e.target.value = "";
          }}
        />
      </div>
      {result ? <p role="status">{result}</p> : null}
      {social.error ? <p className="form-error">{(social.error as Error).message}</p> : null}
    </Section>
  );
}

type Frame = "price" | "festival";

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The picture could not be opened."));
    img.src = src;
  });

/** Draws a branded frame over a product photo in the browser, so the Worker never spends CPU on images. */
export async function drawFrame(canvas: HTMLCanvasElement, photo: MediaAsset, frame: Frame, text: { title: string; line: string; business: string }) {
  const img = await loadImage(photo.url);
  const size = 1080;
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d")!;
  const css = getComputedStyle(document.documentElement);
  const carbon = css.getPropertyValue("--carbon").trim() || "#27408b";
  const paper = css.getPropertyValue("--paper").trim() || "#f3f5f7";
  const graphite = css.getPropertyValue("--graphite").trim() || "#2a2d31";
  const scale = Math.max(size / img.naturalWidth, size / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  g.font = "700 54px 'Atkinson Hyperlegible Next', system-ui, sans-serif";
  if (frame === "price") {
    const pad = 36;
    g.font = "700 64px 'Atkinson Hyperlegible Next', system-ui, sans-serif";
    const priceW = g.measureText(text.line).width;
    g.font = "500 34px 'Atkinson Hyperlegible Next', system-ui, sans-serif";
    const titleW = g.measureText(text.title).width;
    const boxW = Math.min(size - 2 * pad, Math.max(priceW, titleW) + 2 * pad);
    const boxH = 170;
    const x = pad;
    const y = size - boxH - pad;
    g.fillStyle = paper;
    g.fillRect(x, y, boxW, boxH);
    g.fillStyle = carbon;
    g.fillRect(x, y, 10, boxH);
    g.fillStyle = graphite;
    g.fillText(text.title, x + pad, y + 56, boxW - 2 * pad);
    g.font = "700 64px 'Atkinson Hyperlegible Next', system-ui, sans-serif";
    g.fillStyle = carbon;
    g.fillText(text.line, x + pad, y + 132, boxW - 2 * pad);
  } else {
    const band = 64;
    g.strokeStyle = carbon;
    g.lineWidth = 6;
    g.strokeRect(band / 2, band / 2, size - band, size - band);
    g.lineWidth = 2;
    g.strokeRect(band / 2 + 14, band / 2 + 14, size - band - 28, size - band - 28);
    g.fillStyle = paper;
    g.fillRect(band, size - band - 92, size - 2 * band, 92);
    g.fillStyle = carbon;
    g.font = "700 46px 'Atkinson Hyperlegible Next', system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText(text.line, size / 2, size - band - 34, size - 3 * band);
    g.textAlign = "start";
  }
  g.font = "500 26px 'Atkinson Hyperlegible Next', system-ui, sans-serif";
  g.fillStyle = paper;
  g.textAlign = "end";
  g.fillText(text.business, size - 40, 56);
  g.textAlign = "start";
}

/** Price tag or festival border on a product photo, added to the post's channels that take pictures. */
export function FrameMaker({ post, report }: { post: Post; report: SocialReport }) {
  const photos = report.media.filter((m) => m.rights === "own" && m.skuId && post.skuIds.includes(m.skuId));
  const price = post.facts.find((f) => f.id.startsWith("mrp:"));
  const festival = post.facts.find((f) => f.id.startsWith("festival:"));
  const [photoId, setPhotoId] = useState(photos[0]?.id ?? "");
  const [frame, setFrame] = useState<Frame>(price ? "price" : "festival");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const social = useSocial();
  const office = useQuery(q.office());
  const id = useId();
  const photo = photos.find((m) => m.id === photoId);
  const sku = photo?.skuId ? photo.skuId : null;
  const business = office.data?.business.name ?? "";
  const line = frame === "price" ? (price ? `${price.value} with GST` : "") : festival ? festival.label : post.topic;
  const title = photo ? (photo.alt.split(",")[0] ?? post.topic) : post.topic;

  useEffect(() => {
    if (!open || !photo || !canvas.current) return;
    setError(null);
    drawFrame(canvas.current, photo, frame, { title: post.facts.find((f) => f.id === `mrp:${sku}`)?.label.split(",")[0] ?? title, line, business }).catch((e: Error) => setError(e.message));
  }, [open, photo, frame, line, business, sku, title, post.facts]);

  if (!photos.length || (!price && !festival)) return null;
  const add = () =>
    canvas.current?.toBlob((blob) => {
      if (!blob || !photo) return;
      const form = new FormData();
      form.set("file", new File([blob], `${post.id}-${frame}.jpg`, { type: "image/jpeg" }));
      form.set("alt", `${photo.alt}${photo.alt ? ". " : ""}${frame === "price" ? `Price tag: ${line}` : `Border for ${line}`}`);
      form.set("skuId", photo.skuId ?? "");
      form.set("rights", "own");
      form.set("width", "1080");
      form.set("height", "1080");
      social.mutate(async () => {
        const asset = await api.uploadMedia(form);
        for (const v of post.variants) if (v.status !== "published" && RULES[v.platform].media.images > 0 && v.platform !== "whatsapp") await api.editVariant(post.id, v.channelId, { mediaIds: [asset.id, ...v.mediaIds.filter((x) => x !== photo.id)].slice(0, RULES[v.platform].media.images) });
        setOpen(false);
      });
    }, "image/jpeg", 0.9);

  return (
    <details className="frame-maker" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Add a price tag or festival border to the photo</summary>
      <div className="frame-maker-body">
        <div className="frame-maker-controls">
          <div className="field">
            <label htmlFor={`${id}-photo`}>Photo</label>
            <select id={`${id}-photo`} className="input" value={photoId} onChange={(e) => setPhotoId(e.target.value)}>
              {photos.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.alt || m.id}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="field frame-maker-kind">
            <legend>Frame</legend>
            {price ? (
              <label>
                <input type="radio" name={`${id}-frame`} checked={frame === "price"} onChange={() => setFrame("price")} /> Price tag, {price.value} with GST
              </label>
            ) : null}
            <label>
              <input type="radio" name={`${id}-frame`} checked={frame === "festival"} onChange={() => setFrame("festival")} /> Border{festival ? ` for ${festival.label}` : ""}
            </label>
          </fieldset>
          <p className="muted">The price comes from the price list, so the check against the books still holds. Your own photo stays your own; nothing is generated.</p>
          <button type="button" className="btn btn-primary" disabled={social.isPending || !!error} onClick={add}>
            Add to the post
          </button>
          {error ? <p className="form-error">{error}</p> : null}
        </div>
        <canvas ref={canvas} className="frame-maker-canvas" aria-label={`Preview: ${title} with ${frame === "price" ? "a price tag" : "a border"}`} />
      </div>
    </details>
  );
}

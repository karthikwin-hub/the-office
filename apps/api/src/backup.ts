import { RETENTION_YEARS } from "@office/engine";
import { seal } from "./envelope";
import type { Env } from "./env";

/**
 * Rule 3(5) of the Companies (Accounts) Rules: books kept electronically are backed up every day on
 * servers physically in India. This puts a gzipped, encrypted copy (`envelope.ts`) in an S3-compatible
 * bucket in an Indian region (any provider that speaks the S3 API), signed with AWS Signature Version 4.
 */
export type BackupTarget = { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string };

export function backupTarget(env: Env): BackupTarget | null {
  const { INDIA_BACKUP_ENDPOINT: endpoint, INDIA_BACKUP_BUCKET: bucket, INDIA_BACKUP_REGION: region, INDIA_BACKUP_ACCESS_KEY_ID: accessKeyId, INDIA_BACKUP_SECRET_ACCESS_KEY: secretAccessKey } = env;
  return endpoint && bucket && region && accessKeyId && secretAccessKey ? { endpoint: endpoint.replace(/\/$/, ""), bucket, region, accessKeyId, secretAccessKey } : null;
}

export async function gzip(text: string): Promise<ArrayBuffer> {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

/** A copy of an office's books as it leaves the office: JSON, gzipped, then sealed with the office's backup key. */
export async function sealedCopy(secret: string, officeId: string, data: unknown): Promise<Uint8Array> {
  return seal(secret, officeId, await gzip(JSON.stringify(data)));
}

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (data: ArrayBuffer | Uint8Array | string) => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
async function hmac(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}
/** RFC 3986, as Signature Version 4 wants paths and query parameters: everything but letters, digits and `-._~` escaped. */
const encodeQuery = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeKey = (key: string) => key.split("/").map(encodeQuery).join("/");

type Bytes = ArrayBuffer | Uint8Array;

/**
 * One request to the store, path-style (`<endpoint>/<bucket>/<key>`), which every S3-compatible store accepts,
 * signed with AWS Signature Version 4. Throws with the store's answer unless it is a success.
 */
async function signed(t: BackupTarget, method: "GET" | "PUT" | "POST", key: string, query: Record<string, string>, body: Bytes | null, extra: Record<string, string>, now: Date): Promise<Response> {
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${encodeQuery(k)}=${encodeQuery(query[k]!)}`)
    .join("&");
  const url = new URL(`${t.endpoint}/${t.bucket}${key ? `/${encodeKey(key)}` : ""}${qs ? `?${qs}` : ""}`);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = await sha256(body ?? "");
  const headers: Record<string, string> = { host: url.host, ...extra, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(headers).sort();
  const canonical = [method, url.pathname, qs, ...names.map((h) => `${h}:${headers[h]}`), "", names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${t.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let key2 = await hmac(`AWS4${t.secretAccessKey}`, day);
  key2 = await hmac(key2, t.region);
  key2 = await hmac(key2, "s3");
  key2 = await hmac(key2, "aws4_request");
  const signature = hex(await hmac(key2, toSign));
  const res = await fetch(url, {
    method,
    headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${t.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` },
    ...(body ? { body } : {}),
  });
  if (!res.ok) throw new Error(`The backup store answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

/** PUT one object. */
export async function putObject(t: BackupTarget, key: string, body: Bytes, contentType: string, now = new Date()): Promise<void> {
  await signed(t, "PUT", key, {}, body, { "content-type": contentType }, now);
}

const unescapeXml = (s: string) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e]!);
/** The raw text inside each `<name>` element; `text()` unescapes a leaf. */
const tags = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]!);
const text = (xml: string, name: string) => tags(xml, name).map(unescapeXml);

/**
 * One page (up to 1,000) of the keys under `prefix` (ListObjectsV2): `truncated` when more are left, with the
 * token for the next page when the store gives one.
 */
export async function listObjects(t: BackupTarget, prefix: string, after?: string, now = new Date()): Promise<{ keys: string[]; truncated: boolean; next: string | null }> {
  const xml = await (await signed(t, "GET", "", { "list-type": "2", prefix, ...(after ? { "continuation-token": after } : {}) }, null, {}, now)).text();
  const keys = tags(xml, "Contents").flatMap((c) => text(c, "Key"));
  const truncated = text(xml, "IsTruncated")[0] === "true";
  return { keys, truncated, next: truncated ? (text(xml, "NextContinuationToken")[0] ?? null) : null };
}

/** Deletes up to 1,000 keys in one request (DeleteObjects). Throws if the store kept any of them. */
export async function deleteObjects(t: BackupTarget, keys: string[], now = new Date()): Promise<void> {
  if (!keys.length) return;
  if (keys.length > 1000) throw new Error("At most 1,000 keys go in one delete.");
  const esc = (k: string) => k.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = enc.encode(`<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${keys.map((k) => `<Object><Key>${esc(k)}</Key></Object>`).join("")}</Delete>`);
  // The S3 API asks for the body's MD5 on this request; it is a checksum here, not a protection.
  const md5 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("MD5", body))));
  const xml = await (await signed(t, "POST", "", { delete: "" }, body, { "content-md5": md5, "content-type": "application/xml" }, now)).text();
  const errors = tags(xml, "Error");
  if (errors.length) throw new Error(`The backup store kept ${errors.length} of ${keys.length}: ${text(errors[0]!, "Code")[0] ?? "unknown error"}`);
}

/** Every copy of one office in the store: its daily copies all sit under `<officeId>/`. */
export const officeBackupPrefix = (officeId: string) => `${officeId}/`;

/** Where a day's copy goes: one object per office per day, so a month of copies sits side by side. */
export const backupKey = (officeId: string, day: string) => `${officeBackupPrefix(officeId)}${day}.json.gz.enc`;
/** A deleted office's books and edit log, kept outside its prefix for the retention period. */
export const retainedKey = (officeId: string, at: string) => `retained/${officeId}/${at.replace(/[:.]/g, "-")}.json.gz.enc`;

/**
 * The last day a deleted office's retained copy is kept: eight years after the end of the financial year
 * (31 March) that follows the purge, the period the copy promises in its own metadata.
 */
export const retainedUntil = (at: Date) => `${at.getUTCFullYear() + RETENTION_YEARS + 1}-03-31`;

/**
 * A retained copy's keep-until date: from the purge time in its key, or from its metadata when a listing
 * carries it, whichever is later. Null when neither says, and such a copy is never deleted.
 */
export function retainedKeepUntil(o: { key: string; customMetadata?: Record<string, string> }): string | null {
  const m = /^retained\/[^/]+\/(\d{4})-\d{2}-\d{2}T/.exec(o.key);
  const fromKey = m ? retainedUntil(new Date(Date.UTC(Number(m[1]), 5, 1))) : null;
  const said = o.customMetadata?.keepUntil;
  const fromMeta = said && /^\d{4}-\d{2}-\d{2}$/.test(said) ? said : null;
  return [fromKey, fromMeta].filter((d): d is string => d !== null).sort().at(-1) ?? null;
}

/** The office a retained copy belongs to. */
export const retainedOffice = (key: string) => /^retained\/([^/]+)\//.exec(key)?.[1] ?? null;

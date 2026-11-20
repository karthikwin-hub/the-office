import { RETENTION_YEARS } from "@office/engine";
import type { Env } from "./env";

/**
 * Rule 3(5) of the Companies (Accounts) Rules: books kept electronically are backed up every day on
 * servers physically in India. This puts a gzipped copy in an S3-compatible bucket in an Indian region
 * (any provider that speaks the S3 API), signed with AWS Signature Version 4.
 */
export type BackupTarget = { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string };

export function backupTarget(env: Env): BackupTarget | null {
  const { INDIA_BACKUP_ENDPOINT: endpoint, INDIA_BACKUP_BUCKET: bucket, INDIA_BACKUP_REGION: region, INDIA_BACKUP_ACCESS_KEY_ID: accessKeyId, INDIA_BACKUP_SECRET_ACCESS_KEY: secretAccessKey } = env;
  return endpoint && bucket && region && accessKeyId && secretAccessKey ? { endpoint: endpoint.replace(/\/$/, ""), bucket, region, accessKeyId, secretAccessKey } : null;
}

export async function gzip(text: string): Promise<ArrayBuffer> {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (data: ArrayBuffer | string) => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
async function hmac(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}
const encodeKey = (key: string) => key.split("/").map((p) => encodeURIComponent(p)).join("/");

/** PUT one object, path-style (`<endpoint>/<bucket>/<key>`), which every S3-compatible store accepts. */
export async function putObject(t: BackupTarget, key: string, body: ArrayBuffer, contentType: string, now = new Date()): Promise<void> {
  const url = new URL(`${t.endpoint}/${t.bucket}/${encodeKey(key)}`);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = await sha256(body);
  const headers: Record<string, string> = { host: url.host, "content-type": contentType, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const signed = Object.keys(headers).sort();
  const canonical = ["PUT", url.pathname, "", ...signed.map((h) => `${h}:${headers[h]}`), "", signed.join(";"), payloadHash].join("\n");
  const scope = `${day}/${t.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let key2 = await hmac(`AWS4${t.secretAccessKey}`, day);
  key2 = await hmac(key2, t.region);
  key2 = await hmac(key2, "s3");
  key2 = await hmac(key2, "aws4_request");
  const signature = hex(await hmac(key2, toSign));
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${t.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}` },
    body,
  });
  if (!res.ok) throw new Error(`The backup store answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Where a day's copy goes: one object per office per day, so a month of copies sits side by side. */
export const backupKey = (officeId: string, day: string) => `${officeId}/${day}.json.gz`;
/** A deleted office's books and edit log, kept outside its prefix for the retention period. */
export const retainedKey = (officeId: string, at: string) => `retained/${officeId}/${at.replace(/[:.]/g, "-")}.json`;

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

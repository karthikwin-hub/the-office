import type { Document, IngestResult, TextItem } from "@office/contracts";
import { readTextLayer } from "@office/engine";
import { loadPdfJs } from "@office/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api, isLive, officePath } from "../api/client";
import { liveOpen, onLive } from "../app/live";
import { watchUnread } from "./watch";

/**
 * The browser reads each PDF's text layer before anything is sent, so the
 * Worker never parses a PDF (it has 10 ms of CPU per request on the free plan).
 */
export async function textLayerOf(data: ArrayBuffer | string): Promise<{ items: TextItem[]; pages: number }> {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument(typeof data === "string" ? data : { data: new Uint8Array(data.slice(0)) }).promise;
  try {
    return { items: await readTextLayer(pdf), pages: pdf.numPages };
  } finally {
    void pdf.destroy();
  }
}

/** First page of a scanned PDF as a JPEG about 1400 px wide, for the vision model. */
async function firstPageImage(data: ArrayBuffer): Promise<Blob | null> {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2.5, 1400 / base.width) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  } finally {
    void pdf.destroy();
  }
}

export async function uploadDocument(file: File): Promise<IngestResult> {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const data = isPdf ? await file.arrayBuffer() : null;
  const { items, pages } = data ? await textLayerOf(data) : { items: [], pages: 1 };
  const form = new FormData();
  form.set("file", file, file.name);
  form.set("items", JSON.stringify(items));
  form.set("pages", String(pages));
  if (data && !items.length) {
    const image = await firstPageImage(data);
    if (image) form.set("image", image, "page-1.jpg");
  }
  return api.upload(form);
}

/** Reads a document already in the office, such as a PDF that arrived by email. */
export async function readStored(doc: Document): Promise<IngestResult> {
  const data = await fetch(officePath(doc.file), { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`Could not open ${doc.id}`);
    return r.arrayBuffer();
  });
  const { items } = await textLayerOf(data);
  if (!items.length && isLive) {
    const image = await firstPageImage(data);
    if (image) return api.scanDocument(doc.id, image);
  }
  return api.readDocument(doc.id, items);
}

const touchesBooks = (key: readonly unknown[]) => key[0] !== "session";

/** A spreadsheet, which the Accountant reads as a list of bills or invoices; anything else is read as one bill. */
export const isRegisterFile = (f: File) => /\.(csv|tsv|xlsx|xlsm|xls|zip)$/i.test(f.name);
export const REGISTER_ACCEPT = ".csv,.xlsx,.xlsm";

export function useUploadRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set("file", file, file.name);
      return api.uploadRegister(form);
    },
    onSettled: () => qc.invalidateQueries({ predicate: (x) => touchesBooks(x.queryKey) }),
  });
}

export function useUpload() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: uploadDocument, onSettled: () => qc.invalidateQueries({ predicate: (x) => touchesBooks(x.queryKey) }) });
}

export function useReadStored() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: readStored, onSettled: () => qc.invalidateQueries({ predicate: (x) => touchesBooks(x.queryKey) }) });
}

/**
 * In the live office, emailed documents wait for an open browser to read them.
 * Whoever has the office open does that quietly, one document at a time. It looks
 * when the office says one arrived and when the tab comes back into view, rather
 * than asking every minute (watch.ts).
 */
export function useBackgroundReader(enabled: boolean) {
  const qc = useQueryClient();
  const busy = useRef(false);
  const again = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const tick = async () => {
      // Already reading: look once more when done, as the office may have said more arrived.
      if (busy.current) return void (again.current = true);
      busy.current = true;
      try {
        const unread = await api.unread();
        for (const doc of unread.filter((d) => d.file.endsWith(".pdf") || /^\/api\/(o\/[^/]+\/)?files\//.test(d.file)))
          await readStored(doc).catch(() => undefined);
        if (unread.length) await qc.invalidateQueries({ predicate: (x) => touchesBooks(x.queryKey) });
      } finally {
        busy.current = false;
        if (again.current) {
          again.current = false;
          void tick();
        }
      }
    };
    return watchUnread({
      look: () => {
        if (document.hidden) return false;
        void tick();
        return true;
      },
      live: { open: liveOpen, on: onLive },
      onReturn: (back) => {
        const visible = () => {
          if (!document.hidden) back();
        };
        document.addEventListener("visibilitychange", visible);
        window.addEventListener("focus", back);
        return () => {
          document.removeEventListener("visibilitychange", visible);
          window.removeEventListener("focus", back);
        };
      },
      every: (fn, ms) => {
        const t = setInterval(fn, ms);
        return () => clearInterval(t);
      },
      delay: () => (document.hasFocus() ? 0 : 5_000 + Math.random() * 15_000),
      after: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
    });
  }, [enabled, qc]);
}

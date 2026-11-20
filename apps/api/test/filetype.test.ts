import { describe, expect, it } from "vitest";
import { audioType, billType, sheetType } from "../src/filetype";
import { parseInbound } from "../src/mail";

const enc = (s: string) => new TextEncoder().encode(s);
const PK = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
const OLE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

describe("the type a received file is stored under", () => {
  it("takes a sheet's type from its name and bytes", () => {
    expect(sheetType("r.csv", enc("a,b\n1,2"))).toBe("text/csv");
    expect(sheetType("r.csv", enc("<html><script>alert(1)</script>"))).toBe("text/csv");
    expect(sheetType("r.tsv", enc("a\tb"))).toBe("text/tab-separated-values");
    expect(sheetType("MTR.xlsx", PK)).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(sheetType("MTR.xlsx", enc("<html>"))).toBeNull();
    expect(sheetType("all.zip", enc("not a zip"))).toBeNull();
    expect(sheetType("r.csv", PK)).toBeNull();
    expect(sheetType("old.xls", OLE)).toBe("application/vnd.ms-excel");
    expect(sheetType("table.xls", enc("<table><tr><td>1</td></tr></table>"))).toBe("text/plain");
    expect(sheetType(null, PK)).toBe("application/zip");
    // UTF-16, as some portals save "Unicode text", with and without a byte-order mark.
    expect(sheetType("r.txt", new Uint8Array([0xff, 0xfe, 0x61, 0, 0x2c, 0]))).toBe("text/plain");
    expect(sheetType("r.txt", new Uint8Array([0x61, 0, 0x2c, 0, 0x62, 0]))).toBe("text/plain");
    expect(sheetType("r.csv", new Uint8Array([0, 0, 1, 0, 0, 7, 0, 0]))).toBeNull();
  });

  it("takes a bill's type from its bytes", () => {
    expect(billType("bill.pdf", "application/octet-stream", enc("%PDF-1.4"))).toBe("application/pdf");
    expect(billType("bill.pdf", "application/pdf", enc("<html>"))).toBeNull();
    expect(billType("photo.jpg", "image/jpeg", PNG)).toBe("image/png");
    expect(billType("photo.png", "image/png", enc("<svg onload=alert(1)>"))).toBeNull();
    expect(billType("page.html", "text/html", enc("<html>"))).toBeNull();
    expect(audioType("audio/ogg")).toBe("audio/ogg");
    expect(audioType("text/html")).toBe("application/octet-stream");
  });

  it("stores an emailed r.csv sent as text/html as text/csv, and drops what its bytes deny", async () => {
    const part = (type: string, name: string, data: string) =>
      [`--b`, `Content-Type: ${type}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "", data].join("\r\n");
    const raw = [
      "From: a@b.test",
      "To: x@y.test",
      "Subject: r",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      part("text/html", "r.csv", "a,b"),
      part("text/html", "MTR.xlsx", "<html>"),
      "--b--",
      "",
    ].join("\r\n");
    const mail = await parseInbound(enc(raw).buffer as ArrayBuffer, { sheets: true });
    expect(mail.attachments.map((a) => [a.filename, a.mimeType])).toEqual([["r.csv", "text/csv"]]);
    expect(mail.skipped).toEqual(["MTR.xlsx"]);
  });
});

import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { dispatch } from "../src/dispatch";
import { OfficeService } from "../src/office";

describe("a post marked as posted by hand", () => {
  it("takes only an https: link, never one that runs script when clicked", () => {
    const office = new OfficeService(structuredClone(loadBooks()));
    const post = office.books.posts.find((p) => p.variants.some((v) => v.status !== "published"))!;
    const variant = post.variants.find((v) => v.status !== "published")!;
    const posted = (url: unknown) => dispatch(office, { method: "POST", path: `/api/social/posts/${post.id}/variants/${variant.channelId}/posted`, query: new URLSearchParams(), body: { url }, role: "owner", user: { name: "Anil Kulkarni", email: "a@x" }, mode: "mock" });
    for (const url of ["javascript:alert(document.cookie)", "JavaScript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "http://www.instagram.com/p/abc", " https://www.instagram.com/p/abc", "file:///etc/passwd", "not a link"]) {
      expect([url, posted(url).status]).toEqual([url, 400]);
      expect(variant.url ?? null).not.toBe(url);
    }
    expect(posted("https://www.instagram.com/p/abc").status).toBe(200);
    expect(post.variants.find((v) => v.channelId === variant.channelId)!.url).toBe("https://www.instagram.com/p/abc");
  });
});

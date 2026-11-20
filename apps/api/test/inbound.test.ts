import { describe, expect, it } from "vitest";
import {
  countMail,
  forwardedByHand,
  MAIL_LIMITS,
  type MailAdmission,
  type MailRate,
  mailSenderOk,
  ownerOf,
  postsAlone,
  provenSender,
  salesSender,
} from "../src/inbound";
import { envelopeProven, mailVerdict, parseInbound } from "../src/mail";

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const h = (key: string, value: string) => ({ key, value });
const CF = (results: string) => `mx.cloudflare.net; ${results}`;
/**
 * The verdict as the Worker gets it: `message.headers` joins every Authentication-Results header with
 * commas, and the message itself has them as lines, Cloudflare's on top (unless `raw` says otherwise).
 */
const verdict = (results: string[], from: string, o: { froms?: string[]; raw?: string[] } = {}) =>
  mailVerdict(
    results.length ? results.join(", ") : null,
    [...(o.raw ?? results).map((r) => h("authentication-results", r)), ...(o.froms ?? [`Someone <${from}>`]).map((f) => h("from", f))],
    from,
  );

describe("who sent a message", () => {
  it("believes only Cloudflare's own result, on top", () => {
    expect(verdict([CF("spf=pass; dkim=pass; dmarc=pass")], "bills@supplier.test").authenticated).toBe(true);
    // No result at all: a forged From is just a header.
    expect(verdict([], "bills@supplier.test").authenticated).toBe(false);
    // Cloudflare's says it failed; one the sender wrote lower down says it passed.
    expect(verdict([CF("spf=fail; dkim=none; dmarc=fail"), "mx.cloudflare.net; dmarc=pass"], "anil@kaveri.test").authenticated).toBe(false);
    // Another service's verdict on top is not Cloudflare's.
    expect(verdict(["mx.example.net; dmarc=pass"], "anil@kaveri.test").authenticated).toBe(false);
  });

  it("takes DMARC for the From domain, or a DKIM signature aligned with it", () => {
    expect(verdict([CF("dmarc=pass header.from=supplier.test")], "bills@supplier.test").authenticated).toBe(true);
    expect(verdict([CF("dmarc=pass header.from=attacker.test")], "bills@supplier.test").authenticated).toBe(false);
    expect(verdict([CF("dkim=pass header.d=supplier.test header.s=s1; dmarc=none")], "bills@mail.supplier.test").authenticated).toBe(true);
    expect(
      verdict(
        [CF("dkim=pass (good signature, 2048 bits; ok) header.d=attacker.test; spf=pass smtp.mailfrom=attacker.test; dmarc=fail")],
        "bills@supplier.test",
      ),
    ).toEqual({ authenticated: false, signedBy: ["attacker.test"], spfFor: "attacker.test" });
    expect(verdict([CF("dkim=fail header.d=supplier.test; dmarc=fail")], "bills@supplier.test").authenticated).toBe(false);
  });

  it("refuses a second result in Cloudflare's name, and a message with two senders", () => {
    expect(verdict([CF("dmarc=pass"), CF("dmarc=pass")], "anil@kaveri.test").authenticated).toBe(false);
    expect(verdict([CF("dmarc=pass")], "anil@kaveri.test", { froms: ["anil@kaveri.test", "x@attacker.test"] }).authenticated).toBe(false);
    expect(verdict([CF("dmarc=pass")], "anil@kaveri.test", { froms: ["anil@kaveri.test, x@attacker.test"] }).authenticated).toBe(false);
  });

  it("reads only Cloudflare's own line, whatever the sender's lines look like once joined", () => {
    const failed = CF("spf=fail smtp.mailfrom=evil.test; dkim=pass header.d=evil.test; dmarc=fail");
    for (const forged of [
      "x/y; dkim=pass header.d=victim.test",
      "; dmarc=pass header.from=victim.test",
      "a b; dkim=pass header.d=victim.test",
      '"q"; dkim=pass header.d=victim.test',
      "x; dmarc=pass",
    ]) {
      expect(verdict([failed, forged], "billing@victim.test").authenticated).toBe(false);
    }
    // Forging a provider's signed forward the same way does not prove the owner's envelope either.
    expect(
      envelopeProven(verdict([failed, "x/y; spf=pass smtp.mailfrom=gmail.com; dkim=pass header.d=gmail.com"], "rakesh@sharma.test"), "anil@gmail.com"),
    ).toBe(false);
    // A quote inside Cloudflare's comment cannot pull the sender's text into it, and an unclosed one is refused.
    expect(
      verdict(
        [CF('spf=pass (sender "a)b"@evil.test) smtp.mailfrom="a)b"@evil.test; dkim=pass header.d=evil.test; dmarc=fail'), "x; dkim=pass header.d=victim.test"],
        "billing@victim.test",
      ).authenticated,
    ).toBe(false);
    expect(verdict([CF('spf=pass smtp.mailfrom="a@evil.test; dkim=pass header.d=victim.test')], "billing@victim.test").authenticated).toBe(false);
    // A repeated result is not believed over the first.
    expect(verdict([CF("dmarc=fail; dmarc=pass")], "billing@victim.test").authenticated).toBe(false);
  });

  it("believes nothing when Cloudflare's line is not the message's own top line", () => {
    // Cloudflare's result reached message.headers but not the message; the sender's top line claims a pass.
    expect(verdict([CF("dmarc=fail"), CF("dmarc=pass")], "billing@victim.test", { raw: [CF("dmarc=pass")] }).authenticated).toBe(false);
    expect(verdict([CF("dmarc=pass")], "billing@victim.test", { raw: [] }).authenticated).toBe(false);
  });

  it("reads the verdict from the headers Cloudflare hands over, never from the message alone", async () => {
    const raw = (top: string) =>
      [top, "From: Supplier <bills@supplier.test>", "To: kaveri@in.the-office.test", "Subject: Bill", "Content-Type: text/plain", "", "Attached.", ""].join(
        "\r\n",
      );
    const signed = "Authentication-Results: mx.cloudflare.net;\r\n dkim=pass header.d=supplier.test;\r\n dmarc=pass header.from=supplier.test";
    expect(
      (await parseInbound(bytes(raw(signed)), { results: CF("dkim=pass header.d=supplier.test; dmarc=pass header.from=supplier.test") })).authenticated,
    ).toBe(true);
    // Cloudflare's result only in the headers it hands over, and a sender's line on top of the message.
    expect(
      (await parseInbound(bytes(raw("Authentication-Results: mx.cloudflare.net; dmarc=pass")), { results: CF("dmarc=pass header.from=supplier.test") }))
        .authenticated,
    ).toBe(false);
    // A result written into the message by its sender, with nothing from Cloudflare.
    expect((await parseInbound(bytes(raw(signed)), { results: null })).authenticated).toBe(false);
    expect((await parseInbound(bytes(raw(signed)))).authenticated).toBe(false);
  });

  it("proves a forwarding envelope only when SPF and the provider's own signature both passed", () => {
    const envelope = "anil+caf_=kaveri.assistant=in.the-office.test@gmail.com";
    expect(envelopeProven(verdict([CF("dkim=pass header.d=gmail.com; spf=pass smtp.mailfrom=gmail.com; dmarc=pass")], "rakesh@sharma.test"), envelope)).toBe(
      true,
    );
    expect(envelopeProven(verdict([CF("dkim=pass header.d=gmail.com; spf=pass; dmarc=none")], "rakesh@sharma.test"), envelope)).toBe(true);
    // A message signed by gmail.com, replayed from someone else's server with the owner's envelope.
    expect(envelopeProven(verdict([CF("dkim=pass header.d=gmail.com; spf=fail smtp.mailfrom=gmail.com; dmarc=pass")], "x@gmail.com"), envelope)).toBe(false);
    expect(envelopeProven(verdict([CF("dkim=pass header.d=gmail.com; spf=pass smtp.mailfrom=attacker.test")], "x@gmail.com"), envelope)).toBe(false);
    expect(envelopeProven(verdict([CF("dkim=pass header.d=attacker.test; spf=pass")], "x@attacker.test"), envelope)).toBe(false);
  });
});

describe("what the office does with a sender", () => {
  const parties = [{ contact: { email: "bills@supplier.test" } }];
  it("posts a known party's bill alone only when the mail is proven theirs", () => {
    expect(postsAlone(parties, "bills@supplier.test", true)).toBe(true);
    expect(postsAlone(parties, "Bills@Supplier.test", false)).toBe(false);
    expect(postsAlone(parties, "someone@else.test", true)).toBe(false);
  });

  it("takes sales reports from members and platforms only when proven", () => {
    const members = new Set(["anil@kaveri.test"]);
    expect(salesSender(members, { from: "anil@kaveri.test", authenticated: true })).toBe("anil@kaveri.test");
    expect(salesSender(members, { from: "anil@kaveri.test", authenticated: false })).toBeNull();
    expect(salesSender(members, { from: "no-reply@amazon.in", authenticated: false })).toBeNull();
    expect(salesSender(members, { from: "no-reply@amazon.in", authenticated: true })).toBe("no-reply@amazon.in");
    expect(salesSender(members, { from: "x@attacker.test", authenticated: true })).toBeNull();
  });

  it("takes mail as an owner's own only when proven, by hand or by their provider's signed forward", () => {
    const owners = [{ email: "anil@kaveri.test", name: "Anil" }];
    // Forged: From is the owner, nothing proves it.
    expect(ownerOf(owners, { from: "anil@kaveri.test", envelope: "x@attacker.test", authenticated: false })).toEqual({ owner: owners[0], proven: false });
    // A stranger whose message names the owner only in a forwarding header is nobody's.
    expect(ownerOf(owners, { from: "rakesh@sharma.test", envelope: "x@attacker.test", authenticated: true })).toBeNull();
    expect(ownerOf(owners, { from: "anil@kaveri.test", envelope: "anil@kaveri.test", authenticated: true })).toEqual({ owner: owners[0], proven: true });
    expect(
      ownerOf(owners, {
        from: "rakesh@sharma.test",
        envelope: "anil+caf_=kaveri.assistant=in.the-office.test@kaveri.test",
        authenticated: false,
        envelopeSigned: true,
      }),
    ).toEqual({ owner: owners[0], proven: true });
    expect(
      ownerOf(owners, {
        from: "rakesh@sharma.test",
        envelope: "anil+caf_=kaveri.assistant=in.the-office.test@kaveri.test",
        authenticated: true,
        envelopeSigned: false,
      }),
    ).toEqual({ owner: owners[0], proven: false });
    // A forged owner From: that their own filter passed on is proven forwarded, but not forwarded by hand.
    expect(forwardedByHand(owners[0]!, { from: "anil@kaveri.test", authenticated: false })).toBe(false);
    expect(forwardedByHand(owners[0]!, { from: "Anil@Kaveri.test", authenticated: true })).toBe(true);
  });
});

describe("what the office takes in before anything is stored", () => {
  it("limits each proven sender, their domain and the office per hour, and says so once", () => {
    const run = (state: MailRate | null, senders: (string | null)[], hour = "2026-11-19T10") => {
      const out = [];
      for (const who of senders) {
        const r = countMail(state, hour, who);
        state = r.state;
        out.push(r);
      }
      return { state, out };
    };
    const one = run(null, Array(MAIL_LIMITS.perSenderHour + 2).fill("x@supplier.test"));
    expect(one.out.filter((r) => !r.refused)).toHaveLength(MAIL_LIMITS.perSenderHour);
    expect(one.out.slice(-2).map((r) => [r.refused, r.first])).toEqual([
      ["sender", true],
      ["sender", false],
    ]);
    // One sender's flood does not shut out the others, and a new hour starts afresh.
    expect(countMail(one.state, "2026-11-19T10", "bills@other.test").refused).toBeNull();
    expect(countMail(one.state, "2026-11-19T11", "x@supplier.test").refused).toBeNull();
    // Many addresses at one domain meet the domain's limit.
    const domain = run(
      null,
      Array.from({ length: MAIL_LIMITS.perDomainHour + 1 }, (_, i) => `s${i}@attacker.test`),
    );
    expect(domain.out.at(-1)).toMatchObject({ refused: "domain", first: true });
    // Many proven domains at once meet the office's own limit.
    const office = run(
      null,
      Array.from({ length: MAIL_LIMITS.provenHour + 2 }, (_, i) => `s@d${i}.test`),
    );
    expect(office.out.filter((r) => r.refused).map((r) => `${r.refused}:${r.first}`)).toEqual(["office:true", "office:false"]);
    expect(Object.keys(office.state!.senders)).toHaveLength(MAIL_LIMITS.provenHour);
  });

  it("keeps unproven mail to its own pool, so forged senders cannot lock out a real one", () => {
    const flood = Array(MAIL_LIMITS.unprovenHour + 5).fill(null) as null[];
    let state: MailRate | null = null;
    const refused = [];
    for (const who of flood) {
      const r = countMail(state, "2026-11-19T10", who);
      state = r.state;
      if (r.refused) refused.push(`${r.refused}:${r.first}`);
    }
    expect(refused).toEqual(["unproven:true", ...Array(4).fill("unproven:false")]);
    expect(state!.senders).toEqual({});
    expect(countMail(state, "2026-11-19T10", "bills@supplier.test").refused).toBeNull();
    // Only a proven address is ever a sender of its own.
    expect(provenSender({ from: "bills@supplier.test", envelope: "x@attacker.test", authenticated: false, envelopeSigned: false })).toBeNull();
    expect(provenSender({ from: "bills@supplier.test", envelope: "x@attacker.test", authenticated: true, envelopeSigned: false })).toBe("bills@supplier.test");
    expect(provenSender({ from: "rakesh@sharma.test", envelope: "anil+caf_=x@gmail.com", authenticated: false, envelopeSigned: true })).toBe("anil@gmail.com");
  });

  it("refuses unproven senders at the sales address and strangers at the assistant's before anything is stored", () => {
    const office = {
      hired: () => true,
      members: [
        { email: "anil@kaveri.test", role: "owner" },
        { email: "rajesh@kaveri.test", role: "accountant" },
      ],
    };
    const a = (o: Partial<MailAdmission>): MailAdmission => ({
      kind: "email",
      from: "x@attacker.test",
      envelope: "x@attacker.test",
      subject: "Bill",
      authenticated: false,
      envelopeSigned: false,
      bytes: 10,
      ...o,
    });
    expect(mailSenderOk(a({ kind: "email" }), office)).toBe("admit");
    expect(mailSenderOk(a({ kind: "support" }), office)).toBe("admit");
    expect(mailSenderOk(a({ kind: "sales", from: "rajesh@kaveri.test" }), office)).toBe("refuse");
    expect(mailSenderOk(a({ kind: "sales", from: "rajesh@kaveri.test", authenticated: true }), office)).toBe("admit");
    expect(mailSenderOk(a({ kind: "sales", from: "no-reply@amazon.in", authenticated: true }), { ...office, hired: () => false })).toBe("drop");
    expect(mailSenderOk(a({ kind: "assistant" }), office)).toBe("drop");
    expect(mailSenderOk(a({ kind: "assistant", from: "rajesh@kaveri.test", authenticated: true }), office)).toBe("drop");
    // Claimed as the owner's: taken in, and the office decides how far to trust it.
    expect(mailSenderOk(a({ kind: "assistant", from: "anil@kaveri.test" }), office)).toBe("admit");
    expect(
      mailSenderOk(a({ kind: "assistant", from: "forwarding-noreply@google.com", subject: "Gmail Forwarding Confirmation", authenticated: true }), office),
    ).toBe("admit");
    expect(mailSenderOk(a({ kind: "assistant", from: "forwarding-noreply@google.com", subject: "Gmail Forwarding Confirmation" }), office)).toBe("drop");
    // The subject alone, from any proven domain, is not Google's confirmation.
    expect(
      mailSenderOk(a({ kind: "assistant", from: "x@attacker.test", subject: "Gmail Forwarding Confirmation (#123456)", authenticated: true }), office),
    ).toBe("drop");
  });
});

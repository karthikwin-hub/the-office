import { type Books, ComplianceProfile, ROUTES } from "@office/contracts";
import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import {
  addManual,
  assign,
  buildObligations,
  chain,
  ComplianceError,
  complianceView,
  dispatch,
  dueReminders,
  filingPack,
  lateCost,
  markFiled,
  mcaMultiple,
  MemoryEditLog,
  OfficeService,
  parseMasterData,
  recordSrn,
  removeManual,
  reopen,
  saveProfile,
  sectionFromCited,
  sha256,
  smallCompany,
  snooze,
  taxYearLabel,
  tdsRef,
  tdsReturnForm,
  verifyChain,
  workingPaper,
} from "../src";
import { kycDue } from "../src/compliance/rules";

const AS_OF = "2026-11-04";
const AT = "2026-11-04T10:00:00+05:30";
const books = () => loadBooks();
const profile = (b: Books) => ComplianceProfile.parse(b.business.compliance ?? {});
const find = (b: Books, id: string, asOf = AS_OF) => buildObligations(b, asOf).find((o) => o.id === id);
const withProfile = (b: Books, change: Partial<ComplianceProfile>) => {
  b.business.compliance = { ...profile(b), ...change };
  return b;
};

describe("which filings apply", () => {
  it("is not a small company above ₹100 crore turnover, so the annual return is MGT-7", () => {
    const b = books();
    expect(smallCompany(b, profile(b)).value).toBe(false);
    expect(find(b, "mgt7:2025-26")?.form).toBe("MGT-7");
  });

  it("is a small company with modest capital and turnover: MGT-7A and a board meeting each half-year", () => {
    const b = books();
    b.business.prevYearTurnoverPaise = 40_00_00_000_00;
    withProfile(b, { paidUpCapitalPaise: 32_00_000_00 });
    expect(smallCompany(b, profile(b)).value).toBe(true);
    expect(find(b, "mgt7:2025-26")?.form).toBe("MGT-7A");
    withProfile(b, { boardMeetings: ["2026-05-14", "2026-08-09"] });
    const meeting = buildObligations(b, AS_OF).find((o) => o.ruleId === "board-meeting" && o.state !== "filed");
    expect(meeting).toMatchObject({ period: "2026-27-H2", dueOn: "2027-03-31" });
  });

  it("wants the next board meeting within 120 days of the last when the company is not small", () => {
    const b = withProfile(books(), { boardMeetings: ["2026-05-14", "2026-08-09"] });
    expect(buildObligations(b, AS_OF).find((o) => o.ruleId === "board-meeting")?.dueOn).toBe("2026-12-07");
  });

  it("is never small as a holding or subsidiary company", () => {
    const b = books();
    b.business.prevYearTurnoverPaise = 40_00_00_000_00;
    withProfile(b, { paidUpCapitalPaise: 32_00_000_00, holdingOrSubsidiary: true });
    expect(smallCompany(b, profile(b)).value).toBe(false);
  });

  it("files GST quarterly under QRMP below ₹5 crore, with PMT-06 in between and 3B on the 22nd in Maharashtra", () => {
    const b = books();
    b.business.prevYearTurnoverPaise = 4_00_00_000_00;
    withProfile(b, { gstFrequency: "quarterly" });
    const all = buildObligations(b, AS_OF);
    const q3 = all.find((o) => o.ruleId === "gstr3b" && o.period === "FY2026-27-Q3");
    expect(q3?.dueOn).toBe("2027-01-22");
    expect(all.some((o) => o.ruleId === "pmt06" && o.period === "2026-11" && o.dueOn === "2026-12-25")).toBe(true);
    expect(all.some((o) => o.ruleId === "gstr3b" && o.period === "2026-11")).toBe(false);
  });

  it("files GST monthly above ₹5 crore whatever the profile says", () => {
    const b = withProfile(books(), { gstFrequency: "quarterly" });
    expect(find(b, "gstr3b:2026-11")?.dueOn).toBe("2026-12-20");
  });

  it("gives the first AGM nine months from the end of the first year", () => {
    const b = withProfile(books(), { incorporatedOn: "2026-06-10", agms: [], calendarFrom: "2026-06-10" });
    expect(find(b, "agm:2026-27", "2027-01-15")?.dueOn).toBe("2027-12-31");
  });

  it("moves a date for a government extension and names the circular", () => {
    const b = books();
    const aoc4 = find(b, "aoc4:2025-26")!;
    expect(aoc4.dueOn).toBe("2026-12-31");
    expect(aoc4.override?.circular).toMatch(/05\/2026/);
  });

  it("asks for DIR-3 KYC once every three financial years, by 30 June", () => {
    expect(kycDue({ id: "d", name: "A", din: "01234567", designation: "Director", appointedOn: null, kycDoneOn: "2026-05-10", dscExpiresOn: null, mcaSigner: false }, AS_OF)).toBe("2029-06-30");
    expect(kycDue({ id: "d", name: "A", din: "01234567", designation: "Director", appointedOn: null, kycDoneOn: "2026-02-10", dscExpiresOn: null, mcaSigner: false }, AS_OF)).toBe("2028-06-30");
  });

  it("charges MCA additional fees in bands of delay, and AOC-4 by the day", () => {
    expect([0, 10, 20, 45, 75, 120, 200].map(mcaMultiple)).toEqual([0, 1, 2, 4, 6, 10, 12]);
    expect(lateCost({ kind: "per-day", perDayPaise: 100_00, capPaise: null, flatPaise: 0 }, 400)).toBe(40_000_00);
    expect(lateCost({ kind: "gst", perDayPaise: 50_00, capPaise: 10_000_00, taxPaise: 0 }, 1000)).toBe(10_000_00);
  });

  it("flags a late item and what it has cost so far", () => {
    const late = buildObligations(books(), AS_OF).filter((o) => o.state === "late");
    expect(late.length).toBeGreaterThan(0);
    for (const o of late) expect(o.daysLeft).toBeLessThan(0);
  });
});

describe("the Income-tax Act 2025 for TDS", () => {
  it("keeps the 1961 section up to 31 March 2026 and uses section 393 with a payment code after", () => {
    expect(tdsRef("194J", "2026-03-31")).toMatchObject({ reference: "194J", code: "" });
    expect(tdsRef("194J", "2026-04-01")).toMatchObject({ reference: "393(1) Sl. 6(iii)", code: "1027" });
    expect(tdsRef("194C", "2026-04-01", { entity: "individual" }).code).toBe("1023");
    expect(tdsRef("194C", "2026-04-01", { entity: "company" }).code).toBe("1024");
  });

  it("reports on Form 140 from tax year 2026-27 and on 26Q before", () => {
    expect(tdsReturnForm("FY2025-26-Q4")).toBe("26Q");
    expect(tdsReturnForm("FY2026-27-Q1")).toBe("Form 140");
    expect(taxYearLabel(2026)).toBe("tax year 2026-27");
    expect(taxYearLabel(2025)).toBe("FY 2025-26");
  });

  it("reads a section however a return cites it", () => {
    expect(sectionFromCited("194J")).toBe("194J");
    expect(sectionFromCited("393(1) Sl. 6(i)")).toBe("194C");
    expect(sectionFromCited("1027")).toBe("194J");
    expect(sectionFromCited("nonsense")).toBeNull();
  });
});

describe("checks from the books", () => {
  it("finds micro and small suppliers paid late, with the tax at stake", () => {
    const v = complianceView(books(), AS_OF);
    const msme = v.checks.find((c) => c.id === "msme")!;
    expect(msme.tone).toBe("red");
    expect(msme.amountPaise).toBeGreaterThan(0);
    expect(msme.proposal?.id).toBe("pay-msme");
  });

  it("has nothing to say about MSME dues when no supplier is micro or small", () => {
    const b = books();
    for (const p of b.parties) p.udyamCategory = "none";
    const msme = complianceView(b, AS_OF).checks.find((c) => c.id === "msme")!;
    expect(msme.tone).not.toBe("red");
    expect(msme.amountPaise).toBe(0);
  });

  it("lists the loans for DPT-3", () => {
    const dpt3 = complianceView(books(), AS_OF).checks.find((c) => c.id === "dpt3")!;
    expect(dpt3.rows.length).toBe(2);
  });

  it("puts a figure at risk on the whole calendar", () => {
    expect(complianceView(books(), AS_OF).atRiskPaise).toBeGreaterThan(0);
  });
});

describe("tracking a filing", () => {
  it("marks filed with the acknowledgement and proof, and reopens", () => {
    const b = books();
    const o = markFiled(b, "gstr1:2026-10", { filedOn: "2026-11-04", ack: "AA271126001", proof: { file: "/files/x", name: "ack.pdf" } }, "Rajesh Mehta", AT);
    expect(o).toMatchObject({ state: "filed", ack: "AA271126001", proof: { name: "ack.pdf" } });
    expect(find(b, "gstr1:2026-10")?.state).toBe("filed");
    expect(reopen(b, "gstr1:2026-10", "Rajesh Mehta", AT).state).not.toBe("filed");
  });

  it("assigns, prepares and snoozes", () => {
    const b = books();
    expect(assign(b, "gstr1:2026-10", { assignee: "ca", progress: "preparing" }, "Anil", AT)).toMatchObject({ assignee: "ca", state: "preparing" });
    expect(snooze(b, "gstr1:2026-10", { until: "2026-11-08", reason: "Waiting for two credit notes" }, "Anil", AT).state).toBe("snoozed");
    expect(snooze(b, "gstr1:2026-10", { until: null, reason: "" }, "Anil", AT).state).not.toBe("snoozed");
  });

  it("marks an MCA form filed once its SRN is approved", () => {
    const b = books();
    const dir12 = buildObligations(b, AS_OF).find((o) => o.form === "DIR-12" && o.state !== "filed")!;
    const sent = recordSrn(b, dir12.id, { number: "AB1234567", createdOn: "2026-11-01", challan: "", status: "resubmission", remarks: "Attach the consent", resubmitBy: "2026-11-15" }, "CS", AT);
    expect(sent.state).not.toBe("filed");
    expect(sent.srn).toMatchObject({ status: "resubmission", resubmitBy: "2026-11-15" });
    expect(recordSrn(b, dir12.id, { number: "AB1234567", createdOn: "2026-11-01", challan: "", status: "approved", remarks: "", resubmitBy: null }, "CS", AT).state).toBe("filed");
  });

  it("adds and removes an item by hand", () => {
    const b = books();
    const o = addManual(b, { form: "Fire NOC", dueOn: "2026-12-15", description: "Renewal", authority: "Fire department" }, "Anil", AT);
    expect(o.source).toBe("manual");
    expect(find(b, o.id)?.form).toBe("Fire NOC");
    removeManual(b, o.id);
    expect(find(b, o.id)).toBeUndefined();
  });

  it("refuses an item that does not exist", () => {
    expect(() => markFiled(books(), "nope:2026", { filedOn: "2026-11-04", ack: "" }, "Anil", AT)).toThrow(ComplianceError);
  });
});

describe("filings raised by events", () => {
  it("raises DIR-12 within 30 days when a director joins", () => {
    const b = books();
    const p = profile(b);
    saveProfile(b, { ...p, directors: [...p.directors, { id: "dir-new", name: "Meera Iyer", din: "10999999", designation: "Director", appointedOn: "2026-11-02", kycDoneOn: null, dscExpiresOn: null, mcaSigner: false }] }, AS_OF);
    const dir12 = buildObligations(b, AS_OF).filter((o) => o.form === "DIR-12" && o.state !== "filed");
    expect(dir12.some((o) => o.dueOn === "2026-12-02")).toBe(true);
  });

  it("raises CHG-1 for a new secured loan", () => {
    const b = books();
    const p = profile(b);
    saveProfile(b, { ...p, loans: [...p.loans, { id: "loan-new", lender: "SBI", kind: "bank", amountPaise: 50_00_000_00, takenOn: "2026-11-01", secured: true, closedOn: null }] }, AS_OF);
    expect(buildObligations(b, AS_OF).some((o) => o.form === "CHG-1" && o.dueOn === "2026-12-01")).toBe(true);
  });
});

describe("what the CA/CS files from", () => {
  it("prepares working papers as CSV", () => {
    const p = workingPaper(books(), "gstr3b:2026-10", AS_OF)!;
    expect(p.mime).toBe("text/csv");
    expect(p.content.split("\n").length).toBeGreaterThan(2);
  });

  it("builds an MCA filing pack with signers and steps, and names who keeps the books for AOC-4", () => {
    const pack = filingPack(books(), "aoc4:2025-26", AS_OF)!;
    expect(pack.signers.length).toBeGreaterThan(0);
    expect(pack.steps.length).toBeGreaterThan(3);
    expect(pack.prefill.some((r) => /books|service provider/i.test(r.label))).toBe(true);
  });

  it("reads pasted master data", () => {
    const tabs = parseMasterData("CIN\tU31900PN2012PTC143857\nCompany Name\tKAVERI ELECTRICALS PRIVATE LIMITED\nDate of last AGM\t26/09/2026\n");
    expect(Object.values(tabs).join(" ")).toMatch(/U31900PN2012PTC143857/);
    expect(Object.values(tabs).join(" ")).toMatch(/26\/09\/2026/);
    const lines = parseMasterData("CIN\nU31900PN2012PTC143857\nDirector\n05512847\n");
    expect(Object.values(lines).join(" ")).toMatch(/U31900PN2012PTC143857/);
    expect(lines.dins).toBe("05512847");
  });
});

describe("reminders", () => {
  it("nudges 7 days, 2 days and on the day, then weekly once late", () => {
    for (const o of dueReminders(books(), AS_OF)) {
      const late = -o.daysLeft;
      expect(o.daysLeft === 7 || o.daysLeft === 2 || o.daysLeft === 0 || (late > 0 && late % 7 === 1)).toBe(true);
    }
  });
});

describe("the books' edit log", () => {
  it("hashes with SHA-256", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("chains entries so an altered one is found", () => {
    const a = chain(null, { at: AT, by: "Anil", coll: "bills", recordId: "B1", action: "create", changes: [] });
    const b = chain(a, { at: AT, by: "Anil", coll: "bills", recordId: "B1", action: "change", changes: [{ field: "number", before: "1", after: "2" }] });
    expect(verifyChain([a, b])).toBe(true);
    expect(verifyChain([a, { ...b, by: "Someone else" }])).toBe(false);
    expect(verifyChain([b])).toBe(false);
  });

  it("records each field changed, by whom, after a request through the router", () => {
    const edits = new MemoryEditLog();
    const o = new OfficeService(loadBooks(), { asOf: AS_OF, edits });
    const before = edits.count();
    const vendor = o.books.parties.find((p) => p.kind === "vendor")!;
    const res = dispatch(o, { method: "PUT", path: ROUTES.partyMsme(vendor.id), query: new URLSearchParams(), body: { udyamCategory: "micro", udyamActivity: "manufacturing", writtenCreditDays: 30 }, role: "owner", user: { name: "Anil Kaveri", email: "anil@x.in" }, mode: "mock" });
    expect(res.status).toBe(200);
    const added = edits.all().slice(before);
    expect(added.some((e) => e.coll === "parties" && e.recordId === vendor.id && e.by === "Anil Kaveri" && e.changes.some((c) => c.field === "writtenCreditDays" && c.after === 30))).toBe(true);
    expect(verifyChain(edits.all())).toBe(true);
  });

  it("writes an auditor's statement for Rule 11(g)", () => {
    const o = new OfficeService(loadBooks(), { asOf: AS_OF });
    const s = o.auditorStatement("2026-27");
    expect(s.content).toMatch(/cannot be switched off/);
    expect(s.content).toMatch(/complete and no entry has been altered/);
  });
});

describe("the compliance routes", () => {
  const req = (o: OfficeService, method: string, path: string, body?: unknown, role: "owner" | "accountant" = "accountant") => dispatch(o, { method, path, query: new URLSearchParams(), body, role, user: { name: role === "owner" ? "Anil Kaveri" : "Rajesh Mehta", email: "x@y.in" }, mode: "mock" });

  it("marks filed and assigns, and every action goes into the audit trail", () => {
    const o = new OfficeService(loadBooks(), { asOf: AS_OF });
    expect(req(o, "POST", ROUTES.complianceAssign("gstr1:2026-10"), { assignee: "ca" }).status).toBe(200);
    const filed = req(o, "POST", ROUTES.complianceFiled("gstr1:2026-10"), { filedOn: "2026-11-04", ack: "AA2711" });
    expect(filed.status).toBe(200);
    expect((filed.body as { state: string }).state).toBe("filed");
    const audit = req(o, "GET", ROUTES.complianceAudit).body as { entries: { text: string }[] };
    expect(audit.entries.some((e) => /Rajesh Mehta marked GSTR-1 filed/.test(e.text))).toBe(true);
    expect(audit.entries.some((e) => /Rajesh Mehta handed GSTR-1 to the CA/.test(e.text))).toBe(true);
  });

  it("refuses a filing without a date, and an unknown item", () => {
    const o = new OfficeService(loadBooks(), { asOf: AS_OF });
    expect(req(o, "POST", ROUTES.complianceFiled("gstr1:2026-10"), { ack: "x" }).status).toBe(400);
    expect(req(o, "POST", ROUTES.complianceFiled("nope:1"), { filedOn: "2026-11-04" }).status).toBe(422);
  });

  it("keeps the proof's name in mockups", () => {
    const o = new OfficeService(loadBooks(), { asOf: AS_OF });
    const r = req(o, "POST", ROUTES.complianceProof, { name: "challan.pdf" });
    expect((r.body as { name: string }).name).toBe("challan.pdf");
  });

  it("refuses MSME details on a customer", () => {
    const o = new OfficeService(loadBooks(), { asOf: AS_OF });
    const customer = o.books.parties.find((p) => p.kind === "customer")!;
    expect(req(o, "PUT", ROUTES.partyMsme(customer.id), { udyamCategory: "micro" }, "owner").status).toBe(400);
  });
});

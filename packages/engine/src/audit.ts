import type { AuditReport, Comparison, FiledReturn, Finding, StagedChange } from "@office/contracts";
import { dateLabel, monthLabel, quarterLabel, quarterMonths } from "./dates";
import { computeGstr1, itcFor, outwardFor } from "./gst";
import type { Ledger } from "./ledger";
import { fromR2, inr, inrShort } from "./money";
import { expectedCustomerTds, expectedTdsByBill, TDS_RULES } from "./tds";

type Audit = { comparisons: Comparison[]; findings: Finding[]; matched: boolean };

function periodLabel(p: string) {
  return p.startsWith("FY") ? quarterLabel(p) + ` ${p.slice(2, 9)}` : monthLabel(p);
}

function auditGstr1(l: Ledger, r: Extract<FiledReturn, { form: "GSTR-1" }>): Audit {
  const computed = computeGstr1(l, r.period);
  const filedInv = new Map(r.data.b2b.flatMap((b) => b.inv.map((i) => [i.inum, { ...i, ctin: b.ctin }] as const)));
  const sum = (g: typeof computed, k: "txval" | "iamt" | "camt" | "samt") =>
    g.b2b.reduce((a, b) => a + b.inv.reduce((x, i) => x + i.itms.reduce((y, t) => y + fromR2(t.itm_det[k]), 0), 0), 0);
  const labels: [string, "txval" | "iamt" | "camt" | "samt"][] = [
    ["Taxable value of B2B invoices", "txval"],
    ["IGST", "iamt"],
    ["CGST", "camt"],
    ["SGST", "samt"],
  ];
  const comparisons: Comparison[] = labels.map(([line, k]) => {
    const books = sum(computed, k);
    const filed = sum(r.data, k);
    return { form: "GSTR-1", line, booksPaise: books, filedPaise: filed, diffPaise: filed - books };
  });
  const findings: Finding[] = [];
  const invoicesByNumber = new Map(l.salesInvoices.map((i) => [i.number, i]));
  for (const b of computed.b2b)
    for (const inv of b.inv) {
      const f = filedInv.get(inv.inum);
      const book = invoicesByNumber.get(inv.inum)!;
      const party = l.party(book.partyId);
      const tax = book.totals.cgstPaise + book.totals.sgstPaise + book.totals.igstPaise;
      if (!f) {
        findings.push({
          id: `gstr1-${r.period}-missing-${book.id}`,
          severity: "high",
          form: "GSTR-1",
          period: r.period,
          title: `Invoice ${inv.inum} to ${party.name} is missing from the ${r.status === "draft" ? "draft" : "filed"} GSTR-1`,
          explanation: `Your books have invoice ${inv.inum} dated ${dateLabel(book.date)} for ${inrShort(book.totals.totalPaise)}, with tax of ${inrShort(tax)}. It is not in the GSTR-1 ${r.status === "draft" ? "your accountant shared" : "that was filed"}. ${party.name} will not see it in their GSTR-2B and cannot claim the credit, and the tax is under-reported.`,
          action: r.status === "draft" ? "Ask your accountant to add the invoice before filing." : "Ask your accountant to report it in the next GSTR-1 as an amendment.",
          impactPaise: tax,
          evidence: [
            { label: `Invoice ${inv.inum}`, ref: { kind: "document", id: book.docId, region: "totals.total" } },
            { label: "Customer GSTIN on the invoice", ref: { kind: "document", id: book.docId, region: "gstin" } },
          ],
        });
      } else if (Math.abs(fromR2(f.val) - fromR2(inv.val)) > 100) {
        findings.push({
          id: `gstr1-${r.period}-value-${book.id}`,
          severity: "medium",
          form: "GSTR-1",
          period: r.period,
          title: `Invoice ${inv.inum} is reported at a different value`,
          explanation: `The books show ₹${inr(fromR2(inv.val))}; the return shows ₹${inr(fromR2(f.val))}.`,
          action: "Check the invoice with your accountant.",
          impactPaise: Math.abs(fromR2(f.val) - fromR2(inv.val)),
          evidence: [{ label: `Invoice ${inv.inum}`, ref: { kind: "document", id: book.docId, region: "totals.total" } }],
        });
      }
    }
  const bookNumbers = new Set(computed.b2b.flatMap((b) => b.inv.map((i) => i.inum)));
  for (const [inum] of filedInv)
    if (!bookNumbers.has(inum))
      findings.push({
        id: `gstr1-${r.period}-extra-${inum}`,
        severity: "medium",
        form: "GSTR-1",
        period: r.period,
        title: `Invoice ${inum} is in the return but not in the books for ${monthLabel(r.period)}`,
        explanation: "An invoice reported to the GST portal should exist in the books for the same month.",
        action: "Ask your accountant where this invoice came from.",
        impactPaise: 0,
        evidence: [],
      });
  return { comparisons, findings, matched: findings.length === 0 };
}

function auditGstr3b(l: Ledger, r: Extract<FiledReturn, { form: "GSTR-3B" }>): Audit {
  const out = outwardFor(l, r.period);
  const itc = itcFor(l, r.period);
  const o = r.data.sup_details.osup_det;
  const claimed = r.data.itc_elg.itc_avl.reduce((acc, x) => ({ i: acc.i + fromR2(x.iamt), c: acc.c + fromR2(x.camt), s: acc.s + fromR2(x.samt) }), { i: 0, c: 0, s: 0 });
  const comparisons: Comparison[] = [
    { form: "GSTR-3B", line: "3.1(a) Outward taxable supplies, taxable value", booksPaise: out.taxablePaise, filedPaise: fromR2(o.txval), diffPaise: fromR2(o.txval) - out.taxablePaise },
    { form: "GSTR-3B", line: "3.1(a) Output IGST", booksPaise: out.igstPaise, filedPaise: fromR2(o.iamt), diffPaise: fromR2(o.iamt) - out.igstPaise },
    { form: "GSTR-3B", line: "3.1(a) Output CGST", booksPaise: out.cgstPaise, filedPaise: fromR2(o.camt), diffPaise: fromR2(o.camt) - out.cgstPaise },
    { form: "GSTR-3B", line: "3.1(a) Output SGST", booksPaise: out.sgstPaise, filedPaise: fromR2(o.samt), diffPaise: fromR2(o.samt) - out.sgstPaise },
    { form: "GSTR-3B", line: "4(A)(5) ITC claimed, IGST", booksPaise: itc.eligible.igstPaise, filedPaise: claimed.i, diffPaise: claimed.i - itc.eligible.igstPaise },
    { form: "GSTR-3B", line: "4(A)(5) ITC claimed, CGST", booksPaise: itc.eligible.cgstPaise, filedPaise: claimed.c, diffPaise: claimed.c - itc.eligible.cgstPaise },
    { form: "GSTR-3B", line: "4(A)(5) ITC claimed, SGST", booksPaise: itc.eligible.sgstPaise, filedPaise: claimed.s, diffPaise: claimed.s - itc.eligible.sgstPaise },
  ];
  const findings: Finding[] = [];
  const outputGap = comparisons.slice(1, 4).reduce((a, c) => a + c.diffPaise, 0);
  if (outputGap < -100)
    findings.push({
      id: `gstr3b-${r.period}-output`,
      severity: "high",
      form: "GSTR-3B",
      period: r.period,
      title: `Output tax in the ${r.status === "draft" ? "draft" : "filed"} GSTR-3B is ${inrShort(-outputGap)} lower than the books`,
      explanation: `Sales in the books for ${monthLabel(r.period)} carry ${inrShort(out.igstPaise + out.cgstPaise + out.sgstPaise)} of GST; the return declares ${inrShort(out.igstPaise + out.cgstPaise + out.sgstPaise + outputGap)}. Paying less than the books show attracts interest at 18% a year on the shortfall.`,
      action: "Make sure GSTR-1 and GSTR-3B both include every sales invoice in the month.",
      impactPaise: -outputGap,
      evidence: [{ label: `Sales register, ${monthLabel(r.period)}`, ref: { kind: "figure", id: `gst:outward:${r.period}` } }],
    });
  for (const b of itc.notIn2b) {
    const vendor = l.party(b.partyId);
    const tax = b.totals.igstPaise + b.totals.cgstPaise + b.totals.sgstPaise;
    const claimedExtra = claimed.i + claimed.c + claimed.s - (itc.eligible.igstPaise + itc.eligible.cgstPaise + itc.eligible.sgstPaise);
    if (claimedExtra <= 0) continue;
    findings.push({
      id: `gstr3b-${r.period}-itc-${b.id}`,
      severity: "high",
      form: "GSTR-3B",
      period: r.period,
      title: `Input tax credit of ${inrShort(tax)} claimed on ${vendor.name}'s bill ${b.number}, which is not in GSTR-2B`,
      explanation: `${vendor.name} has not reported bill ${b.number} dated ${dateLabel(b.date)} in their GSTR-1, so it does not appear in your GSTR-2B for ${monthLabel(r.period)}. Credit can only be claimed once it appears there (section 16(2)(aa) of the CGST Act). Claiming it now risks reversal with interest.`,
      action: `Hold this credit until ${vendor.name} files, and ask them to do so. Your accountant should remove it from this month's GSTR-3B.`,
      impactPaise: tax,
      evidence: [
        { label: `Bill ${b.number}`, ref: { kind: "document", id: b.docId, region: "totals.igst" } },
        { label: "Supplier GSTIN", ref: { kind: "document", id: b.docId, region: "gstin" } },
      ],
    });
  }
  return { comparisons, findings, matched: findings.length === 0 && comparisons.every((c) => Math.abs(c.diffPaise) <= 100) };
}

function audit26q(l: Ledger, r: Extract<FiledReturn, { form: "26Q" }>): Audit {
  const expected = expectedTdsByBill(l);
  const months = new Set(quarterMonths(r.period));
  const filedByBill = new Map(r.data.deductions.map((d) => [d.billId, d]));
  const bills = l.postedBills.filter((b) => months.has(b.date.slice(0, 7)));
  let expectedTotal = 0;
  const findings: Finding[] = [];
  const shortByVendor = new Map<string, { bills: typeof bills; short: number; bookedBp: number; ruleBp: number }>();
  for (const b of bills) {
    const e = expected.get(b.id);
    if (!e) continue;
    expectedTotal += e.amountPaise;
    const filed = filedByBill.get(b.id);
    const vendor = l.party(b.partyId);
    if (!filed) {
      findings.push({
        id: `26q-${r.period}-missing-${b.id}`,
        severity: "high",
        form: "26Q",
        period: r.period,
        title: `TDS of ${inrShort(b.tds?.amountPaise ?? e.amountPaise)} on ${vendor.name}'s bill ${b.number} is missing from the 26Q`,
        explanation: `The books show TDS under section ${e.section} deducted on bill ${b.number} dated ${dateLabel(b.date)}, but the return for ${quarterLabel(r.period)} does not include it. ${vendor.name} will not get credit in their Form 26AS, and the department will treat the deduction as unreported.`,
        action: "Ask your accountant to file a correction statement for the quarter.",
        impactPaise: b.tds?.amountPaise ?? e.amountPaise,
        evidence: [{ label: `Bill ${b.number}`, ref: { kind: "document", id: b.docId, region: "totals.taxable" } }],
      });
      continue;
    }
    if (filed.tdsPaise < e.amountPaise - 100) {
      const entry = shortByVendor.get(vendor.id) ?? { bills: [], short: 0, bookedBp: b.tds?.rateBp ?? 0, ruleBp: e.rateBp };
      entry.bills.push(b);
      entry.short += e.amountPaise - filed.tdsPaise;
      shortByVendor.set(vendor.id, entry);
    }
  }
  for (const [vendorId, s] of shortByVendor) {
    const vendor = l.party(vendorId);
    const section = vendor.tdsSection!;
    findings.push({
      id: `26q-${r.period}-rate-${vendorId}`,
      severity: "high",
      form: "26Q",
      period: r.period,
      title: `TDS on ${vendor.name} deducted at ${s.bookedBp / 100}% instead of ${s.ruleBp / 100}%: short by ${inrShort(s.short)}`,
      explanation: `${s.bills.length} bill${s.bills.length === 1 ? "" : "s"} for ${quarterLabel(r.period)} were treated as ${s.bookedBp === 200 ? "technical services (2%)" : `${s.bookedBp / 100}%`}. These are ${TDS_RULES[section].nature.toLowerCase()} under section ${section}, which attract ${TDS_RULES[section].rateLabel}. Short deduction makes the business liable for the difference plus interest at 1% a month, and the expense can be partly disallowed.`,
      action: "Deposit the shortfall with interest and file a correction statement.",
      impactPaise: s.short,
      evidence: s.bills.map((b) => ({ label: `Bill ${b.number}`, ref: { kind: "document" as const, id: b.docId, region: "totals.taxable" } })),
    });
  }
  const filedTotal = r.data.deductions.reduce((a, d) => a + d.tdsPaise, 0);
  return {
    comparisons: [{ form: "26Q", line: `TDS for ${quarterLabel(r.period)}`, booksPaise: expectedTotal, filedPaise: filedTotal, diffPaise: filedTotal - expectedTotal }],
    findings,
    matched: findings.length === 0,
  };
}

function audit26as(l: Ledger, quarter: string): Finding[] {
  const expected = expectedCustomerTds(l);
  const months = new Set(quarterMonths(quarter));
  const credited = new Map(l.books.form26as.filter((c) => c.quarter === quarter).map((c) => [c.invoiceId, c]));
  const findings: Finding[] = [];
  for (const [invoiceId, amount] of expected) {
    const inv = l.invoice(invoiceId)!;
    if (!months.has(inv.date.slice(0, 7))) continue;
    if (!l.settled(invoiceId).tds) continue; // customer has not paid yet, so has not deducted
    if (credited.has(invoiceId)) continue;
    const party = l.party(inv.partyId);
    findings.push({
      id: `26as-${quarter}-${invoiceId}`,
      severity: "medium",
      form: "Form 26AS",
      period: quarter,
      title: `${party.name} deducted ${inrShort(amount)} TDS on ${inv.number} but it is not in your Form 26AS`,
      explanation: `${party.name} paid invoice ${inv.number} net of TDS under section 194Q. Until they report it in their own TDS return, the credit will not appear in your Form 26AS and you cannot claim it against your income tax.`,
      action: `Ask ${party.contact.name} at ${party.name} to include it in a correction statement.`,
      impactPaise: amount,
      evidence: [{ label: `Invoice ${inv.number}`, ref: { kind: "document", id: inv.docId, region: "totals.taxable" } }],
    });
  }
  return findings;
}

export function auditAll(l: Ledger) {
  const returns: AuditReport["returns"] = [];
  const comparisons: (Comparison & { period: string })[] = [];
  const findings: Finding[] = [];
  for (const r of l.books.filedReturns) {
    const a = r.form === "GSTR-1" ? auditGstr1(l, r) : r.form === "GSTR-3B" ? auditGstr3b(l, r) : audit26q(l, r);
    returns.push({ id: r.id, form: r.form, period: r.period, status: r.status, filedOn: r.filedOn, sharedOn: r.sharedOn, matched: a.matched });
    comparisons.push(...a.comparisons.map((c) => ({ ...c, period: r.period })));
    findings.push(...a.findings);
  }
  for (const q of [...new Set(l.books.form26as.map((c) => c.quarter))]) findings.push(...audit26as(l, q));
  return { returns, comparisons, findings };
}

export function auditReport(l: Ledger, period?: string): AuditReport {
  const all = auditAll(l);
  const periods = [...new Set(all.returns.map((r) => r.period))].sort().reverse();
  const selected = period ?? periods.find((p) => !p.startsWith("FY")) ?? periods[0] ?? "";
  const findings = all.findings.filter((f) => f.period === selected);
  const impact = findings.reduce((a, f) => a + f.impactPaise, 0);
  const openTotal = all.findings.length;
  return {
    period: selected,
    periods,
    note: !selected
      ? [{ text: "Your accountant has not shared any filed returns yet. Import a GSTR-1, GSTR-3B or 26Q and the Auditor will check it against the books." }]
      : findings.length === 0
        ? [{ text: `Everything your accountant filed for ${periodLabel(selected)} matches the books.` }]
        : [
            { text: `For ${periodLabel(selected)} the Auditor found ${findings.length} difference${findings.length === 1 ? "" : "s"} between the books and your accountant's returns, worth ` },
            { text: inrShort(impact), figureId: `audit:impact:${selected}`, tone: "red" },
            { text: ` in tax. Across all periods there are ${openTotal} open differences.` },
          ],
    returns: all.returns.filter((r) => r.period === selected),
    comparisons: all.comparisons.filter((c) => c.period === selected).map(({ period: _p, ...c }) => c),
    findings,
  };
}

/** Each open finding becomes a desk item: raise it with the accountant. */
export function auditFlags(l: Ledger): StagedChange[] {
  const firm = l.books.business.accountantFirm;
  return auditAll(l).findings.map((f) => ({
    id: `aud-${f.id}`,
    agentId: "auditor",
    kind: "audit_flag" as const,
    createdAt: `${l.asOf}T10:58:00+05:30`,
    title: `Raise with ${firm.split(",")[0]}: ${f.title.charAt(0).toLowerCase()}${f.title.slice(1)}`,
    summary: f.explanation,
    evidence: f.evidence,
    payload: { findingId: f.id, action: f.action, impactPaise: f.impactPaise, form: f.form, period: f.period },
    status: "pending" as const,
  }));
}

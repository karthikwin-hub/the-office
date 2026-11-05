"""Render invoices and bills with reportlab, recording where each figure is printed.

Regions are stored as [x, y, w, h] fractions of the page with the origin at the
top-left, which is how the source viewer overlays its highlight on pdf.js pages.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

from money import inr, words

W, H = A4

TEMPLATES = {
    # family, bold family, header alignment, rule weight, accent grey
    "OURS": ("Helvetica", "Helvetica-Bold", "left", 0.8, 0.25),
    "A": ("Helvetica", "Helvetica-Bold", "left", 0.5, 0.45),
    "B": ("Times-Roman", "Times-Bold", "center", 1.0, 0.1),
    "C": ("Courier", "Courier-Bold", "left", 0.6, 0.35),
}


class Page:
    def __init__(self, path: Path, template: str):
        self.c = canvas.Canvas(str(path), pagesize=A4, pageCompression=1)
        self.c.setAuthor("The Office synthetic data")
        self.font, self.bold, self.align, self.rule_w, self.grey = TEMPLATES[template]
        self.regions: list[dict] = []

    def text(self, x: float, y: float, s: str, size: float = 9, bold: bool = False, align: str = "left", key: str | None = None, label: str | None = None):
        font = self.bold if bold else self.font
        self.c.setFont(font, size)
        w = stringWidth(s, font, size)
        if align == "right":
            self.c.drawRightString(x, y, s)
            left = x - w
        elif align == "center":
            self.c.drawCentredString(x, y, s)
            left = x - w / 2
        else:
            self.c.drawString(x, y, s)
            left = x
        if key:
            pad = 2.5
            top = y + size * 0.82 + pad
            bottom = y - size * 0.25 - pad
            self.regions.append(
                {
                    "key": key,
                    "label": label or key,
                    "page": 1,
                    "box": [
                        round((left - pad) / W, 5),
                        round((H - top) / H, 5),
                        round((w + 2 * pad) / W, 5),
                        round((top - bottom) / H, 5),
                    ],
                }
            )
        return w

    def rule(self, x1: float, y: float, x2: float, weight: float | None = None):
        self.c.setLineWidth(weight or self.rule_w)
        self.c.line(x1, y, x2, y)

    def box(self, x: float, y: float, w: float, h: float):
        self.c.setLineWidth(self.rule_w)
        self.c.rect(x, y, w, h)

    def grey_fill(self, x: float, y: float, w: float, h: float):
        g = 1 - (1 - self.grey) * 0.12
        self.c.setFillGray(g)
        self.c.rect(x, y, w, h, stroke=0, fill=1)
        self.c.setFillGray(0)

    def save(self) -> list[dict]:
        self.c.showPage()
        self.c.save()
        return self.regions


def fmt_date(iso: str) -> str:
    return date.fromisoformat(iso).strftime("%d %b %Y")


def _fit(text: str, font: str, size: float, width: float) -> str:
    if stringWidth(text, font, size) <= width:
        return text
    while text and stringWidth(text + ".", font, size) > width:
        text = text[:-1]
    return text.rstrip() + "."


def _lines_table(p: Page, lines: list[dict], top: float, intra: bool, show_disc: bool) -> float:
    size = 7.5 if p.font == "Courier" else 8.5
    cols = [(40, "No", "left"), (62, "Description", "left"), (250, "HSN/SAC", "left"), (330, "Qty", "right"), (390, "Rate", "right")]
    if show_disc:
        cols.append((418, "Disc", "right"))
    cols += [(476, "Taxable", "right"), (502, "GST", "right"), (558, "Tax", "right")]
    p.grey_fill(36, top - 6, W - 72, 18)
    for x, label, align in cols:
        p.text(x, top, label, size - 0.5, bold=True, align=align)
    p.rule(36, top - 6, W - 36)
    y = top - 22
    for i, l in enumerate(lines):
        tax = l["cgstPaise"] + l["sgstPaise"] + l["igstPaise"]
        p.text(40, y, str(i + 1), size)
        desc = _fit(l["description"], p.font, size, 180)
        p.text(62, y, desc, size, key=f"line.{i}.description", label=f"Line {i + 1} description")
        p.text(250, y, l["hsn"], size, key=f"line.{i}.hsn", label=f"Line {i + 1} HSN")
        qty = f"{l['qty']} {l['unit']}" if l["unit"] != "OTH" else "1"
        p.text(330, y, qty, size, align="right", key=f"line.{i}.qty", label=f"Line {i + 1} quantity")
        p.text(390, y, inr(l["ratePaise"]), size, align="right")
        if show_disc:
            p.text(418, y, f"{l['discountPct']}%", size, align="right")
        p.text(476, y, inr(l["taxablePaise"]), size, align="right", key=f"line.{i}.taxable", label=f"Line {i + 1} taxable value")
        p.text(502, y, f"{l['gstRate']}%", size, align="right", key=f"line.{i}.rate", label=f"Line {i + 1} GST rate")
        p.text(558, y, inr(tax), size, align="right", key=f"line.{i}.tax", label=f"Line {i + 1} tax")
        y -= 16
    p.rule(36, y + 6, W - 36)
    return y


def _totals(p: Page, totals: dict, y: float, intra: bool, registered: bool = True) -> float:
    rows = [("Taxable value", totals["taxablePaise"], "totals.taxable")]
    if registered:
        if intra:
            rows += [("CGST", totals["cgstPaise"], "totals.cgst"), ("SGST", totals["sgstPaise"], "totals.sgst")]
        else:
            rows += [("IGST", totals["igstPaise"], "totals.igst")]
    rows += [("Round off", totals["roundOffPaise"], "totals.roundOff")]
    y -= 8
    size = 8 if p.font == "Courier" else 9
    for label, value, key in rows:
        p.text(392, y, label, size)
        p.text(558, y, inr(value), size, align="right", key=key, label=label)
        y -= 14
    p.rule(386, y + 8, W - 36)
    y -= 6
    p.text(392, y, "Total", 11, bold=True)
    p.text(558, y, inr(totals["totalPaise"]), 11, bold=True, align="right", key="totals.total", label="Invoice total")
    return y - 20


def render_sales_invoice(path: Path, inv: dict, party: dict, business: dict, states: dict) -> list[dict]:
    p = Page(path, "OURS")
    intra = inv["placeOfSupply"] == business["stateCode"]
    p.text(40, 800, business["legalName"], 15, bold=True)
    p.text(40, 785, business["address"], 8.5)
    p.text(40, 773, f"GSTIN {business['gstin']}   PAN {business['pan']}", 8.5)
    p.text(40, 761, f"{business['phone']}   {business['email']}", 8.5)
    p.text(W - 40, 800, "Tax invoice", 13, bold=True, align="right")
    p.text(W - 40, 786, "Original for recipient", 8, align="right")
    p.rule(36, 748, W - 36, 1.2)

    p.text(40, 730, "Invoice no", 8)
    p.text(40, 717, inv["number"], 10, bold=True, key="number", label="Invoice number")
    p.text(170, 730, "Invoice date", 8)
    p.text(170, 717, fmt_date(inv["date"]), 10, key="date", label="Invoice date")
    p.text(270, 730, "Payment terms", 8)
    p.text(270, 717, f"{inv['termsDays']} days", 10, key="terms", label="Payment terms")
    p.text(370, 730, "Due date", 8)
    p.text(370, 717, fmt_date(inv["dueDate"]), 10, bold=True, key="dueDate", label="Due date")
    p.rule(36, 705, W - 36)

    p.text(40, 690, "Bill to", 8)
    p.text(40, 676, party["name"], 11, bold=True, key="party", label="Customer")
    p.text(40, 663, f"{party['city']}, {states[party['stateCode']]}", 8.5)
    p.text(40, 651, f"GSTIN {party['gstin']}", 8.5, key="gstin", label="Customer GSTIN")
    p.text(330, 690, "Place of supply", 8)
    p.text(330, 676, f"{states[inv['placeOfSupply']]} ({inv['placeOfSupply']})", 10, key="pos", label="Place of supply")
    p.text(330, 663, "Reverse charge: No", 8.5)
    p.text(330, 651, "Supply type: " + ("Intra-state (CGST + SGST)" if intra else "Inter-state (IGST)"), 8.5)

    y = _lines_table(p, inv["lines"], 625, intra, show_disc=True)
    y = _totals(p, inv["totals"], y, intra)
    p.text(40, y, words(inv["totals"]["totalPaise"]), 8.5, key="totals.words", label="Amount in words")
    y -= 28
    p.text(40, y, "Bank details", 8, bold=True)
    p.text(40, y - 12, business["bank"], 8.5)
    p.text(40, y - 30, f"Interest at 18% per annum applies to payments received after the due date.", 7.5)
    p.text(40, y - 41, "Goods once sold are subject to Pune jurisdiction. E. & O.E.", 7.5)
    p.text(W - 40, y - 12, f"For {business['legalName']}", 8.5, align="right")
    p.text(W - 40, y - 52, "Authorised signatory", 8.5, align="right")
    return p.save()


def render_bill(path: Path, bill: dict, vendor: dict, business: dict, states: dict) -> list[dict]:
    template = vendor.get("_template", "A")
    p = Page(path, template)
    intra = vendor["stateCode"] == business["stateCode"]
    registered = bool(vendor["gstin"])
    title = "Tax invoice" if registered else "Bill"
    if p.align == "center":
        p.text(W / 2, 805, vendor["name"].upper() if template == "B" else vendor["name"], 16, bold=True, align="center", key="party", label="Supplier")
        p.text(W / 2, 790, f"{vendor['city']}, {states[vendor['stateCode']]}", 9, align="center")
        if registered:
            p.text(W / 2, 777, f"GSTIN: {vendor['gstin']}", 9, align="center", key="gstin", label="Supplier GSTIN")
        p.text(W / 2, 757, title.upper(), 12, bold=True, align="center")
        p.box(36, 700, W - 72, 46)
        info_y = 730
    else:
        p.text(40, 805, vendor["name"], 14, bold=True, key="party", label="Supplier")
        p.text(40, 791, f"{vendor['city']}, {states[vendor['stateCode']]}   {vendor['contact']['email']}", 8.5)
        if registered:
            p.text(40, 779, f"GSTIN {vendor['gstin']}   PAN {vendor['pan']}", 8.5, key="gstin", label="Supplier GSTIN")
        else:
            p.text(40, 779, f"PAN {vendor['pan']}   Not registered under GST", 8.5)
        p.text(W - 40, 805, title, 12, bold=True, align="right")
        p.rule(36, 766, W - 36, 1)
        info_y = 744

    p.text(44, info_y, "Bill no", 8)
    p.text(44, info_y - 13, bill["number"], 10, bold=True, key="number", label="Bill number")
    p.text(200, info_y, "Date", 8)
    p.text(200, info_y - 13, fmt_date(bill["date"]), 10, key="date", label="Bill date")
    p.text(330, info_y, "Billed to", 8)
    p.text(330, info_y - 13, business["legalName"], 9, bold=True)
    p.text(330, info_y - 25, f"GSTIN {business['gstin']}", 8)

    y = _lines_table(p, bill["lines"], 670, intra, show_disc=False)
    y = _totals(p, bill["totals"], y, intra, registered)
    p.text(40, y, words(bill["totals"]["totalPaise"]), 8.5, key="totals.words", label="Amount in words")
    p.text(40, y - 30, "Payment within 30 days by NEFT. Please quote the bill number.", 8)
    p.text(W - 40, y - 30, f"For {vendor['name']}", 8.5, align="right")
    p.text(W - 40, y - 64, "Authorised signatory", 8.5, align="right")
    return p.save()

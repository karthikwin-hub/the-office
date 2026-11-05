"""Generate the sample business behind The Office mockups.

One deterministic seed produces every record for every team, plus a PDF for each
sales invoice and purchase bill with the page region of each printed figure.

    python3 tools/synthetic/generate.py            # writes fixtures and PDFs

Outputs
    packages/fixtures/data/office.json
    apps/web/public/docs/<document id>.pdf
"""

from __future__ import annotations

import json
import random
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import catalog as cat  # noqa: E402
from money import bp_of, line_taxable, make_gstin, pct_of, round_to_rupee  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DATA_OUT = ROOT / "packages/fixtures/data/office.json"
PDF_OUT = ROOT / "apps/web/public/docs"

SEED = 2611
rng = random.Random(SEED)

FY_START = date(2026, 4, 1)
AS_OF = date(2026, 11, 4)
OUR_STATE = cat.BUSINESS["stateCode"]


def iso(d: date) -> str:
    return d.isoformat()


def stamp(d: date, hh: int, mm: int) -> str:
    return datetime(d.year, d.month, d.day, hh, mm).isoformat() + "+05:30"


def letters(n: int) -> str:
    return "".join(rng.choice("ABCDEFGHJKLMNPRSTUVWXYZ") for _ in range(n))


def make_pan(name: str, entity: str) -> str:
    kind = {"company": "C", "firm": "F", "individual": "P"}[entity]
    return letters(3) + kind + name[0].upper() + f"{rng.randint(1000, 9999)}" + letters(1)


def slug(name: str) -> str:
    return "".join(ch for ch in name.lower() if ch.isalnum())[:18]


# ---------------------------------------------------------------- master data

parties: list[dict] = []
for cid, name, city, state, entity, terms, profile, weight, buyer, contact in cat.CUSTOMERS:
    pan = make_pan(name, entity)
    parties.append(
        {
            "id": cid,
            "kind": "customer",
            "name": name,
            "entity": entity,
            "gstin": make_gstin(state, pan),
            "pan": pan,
            "stateCode": state,
            "city": city,
            "contact": {
                "name": contact,
                "phone": f"+91 9{rng.randint(100000000, 999999999)}",
                "email": f"accounts@{slug(name)}.in",
            },
            "paymentTermsDays": terms,
            "creditLimitPaise": rng.choice([10, 15, 20, 25, 40, 60]) * 1_00_000_00,
            "buyerType": buyer,
            "tan": cat.TDS_DEDUCTING_CUSTOMERS.get(cid),
        }
    )
    parties[-1]["_profile"] = profile
    parties[-1]["_weight"] = weight

for vid, name, city, state, entity, registered, supply, section, bp, template in cat.VENDORS:
    pan = make_pan(name, entity)
    parties.append(
        {
            "id": vid,
            "kind": "vendor",
            "name": name,
            "entity": entity,
            "gstin": make_gstin(state, pan) if registered else None,
            "pan": pan,
            "stateCode": state,
            "city": city,
            "contact": {
                "name": "Accounts desk",
                "phone": f"+91 9{rng.randint(100000000, 999999999)}",
                "email": f"billing@{slug(name)}.in",
            },
            "supplyKind": supply,
            "tdsSection": section,
            "tdsRateBp": bp,
        }
    )
    parties[-1]["_template"] = template

party_by_id = {p["id"]: p for p in parties}
customers = [p for p in parties if p["kind"] == "customer"]

skus = []
for sid, name, hsn, unit, rate, price, category in cat.SKUS:
    cost = int(price * 100 * rng.uniform(0.72, 0.86))
    skus.append(
        {
            "id": sid,
            "name": name,
            "hsn": hsn,
            "unit": unit,
            "gstRate": rate,
            "pricePaise": price * 100,
            "costPaise": cost,
            "category": category,
        }
    )
sku_by_id = {s["id"]: s for s in skus}
skus_by_category: dict[str, list[dict]] = {}
for s in skus:
    skus_by_category.setdefault(s["category"], []).append(s)

# Popularity skew so some SKUs are slow movers
sku_pop = {s["id"]: rng.choice([0.25, 0.6, 1, 1, 1.4, 2.2]) for s in skus}
for slow in ("SKU-109", "SKU-204", "SKU-404", "SKU-308", "SKU-603"):
    sku_pop[slow] = 0.12

# ---------------------------------------------------------------- invoices

documents: list[dict] = []
invoices: list[dict] = []
bills: list[dict] = []
payments: list[dict] = []


def build_lines(chosen: list[tuple[dict, int]], pos: str, discount: int) -> tuple[list[dict], dict]:
    lines = []
    intra = pos == OUR_STATE
    for sku, qty in chosen:
        taxable = line_taxable(qty, sku["pricePaise"], discount)
        rate = sku["gstRate"]
        if intra:
            cgst = pct_of(taxable, rate * 50)
            sgst = pct_of(taxable, rate * 50)
            igst = 0
        else:
            cgst = sgst = 0
            igst = pct_of(taxable, rate * 100)
        lines.append(
            {
                "skuId": sku["id"],
                "description": sku["name"],
                "hsn": sku["hsn"],
                "qty": qty,
                "unit": sku["unit"],
                "ratePaise": sku["pricePaise"],
                "discountPct": discount,
                "taxablePaise": taxable,
                "gstRate": rate,
                "cgstPaise": cgst,
                "sgstPaise": sgst,
                "igstPaise": igst,
            }
        )
    totals = totals_of(lines)
    return lines, totals


def totals_of(lines: list[dict]) -> dict:
    taxable = sum(l["taxablePaise"] for l in lines)
    cgst = sum(l["cgstPaise"] for l in lines)
    sgst = sum(l["sgstPaise"] for l in lines)
    igst = sum(l["igstPaise"] for l in lines)
    gross = taxable + cgst + sgst + igst
    total = round_to_rupee(gross)
    return {
        "taxablePaise": taxable,
        "cgstPaise": cgst,
        "sgstPaise": sgst,
        "igstPaise": igst,
        "roundOffPaise": total - gross,
        "totalPaise": total,
    }


def pick_lines(buyer: str) -> list[tuple[dict, int]]:
    mix = cat.BUYER_MIX[buyer]
    n = rng.randint(2, 7)
    chosen: dict[str, tuple[dict, int]] = {}
    for _ in range(n * 3):
        if len(chosen) >= n:
            break
        category, (lo, hi) = rng.choice(mix)
        pool = skus_by_category[category]
        sku = rng.choices(pool, weights=[sku_pop[s["id"]] for s in pool])[0]
        if sku["id"] in chosen:
            continue
        qty = max(1, int(rng.randint(lo, hi) * 0.5))
        if sku["unit"] == "MTR":
            qty = rng.choice([50, 50, 100, 100, 150, 250])
        chosen[sku["id"]] = (sku, qty)
    return list(chosen.values())


business_days = []
d = FY_START
while d <= AS_OF:
    if d.weekday() != 6:
        business_days.append(d)
    d += timedelta(days=1)

weights = [c["_weight"] for c in customers]
inv_seq = 0
for day in business_days:
    count = rng.choices([0, 1, 2, 3], weights=[12, 38, 35, 15])[0]
    if day.month == 10 and day.day in (14, 15, 16):  # Diwali stocking peak
        count += 2
    for _ in range(count):
        cust = rng.choices(customers, weights=weights)[0]
        inv_seq += 1
        number = f"KE/26-27/{inv_seq:04d}"
        discount = rng.choice([0, 0, 0, 2, 3, 5]) if cust["buyerType"] == "project" else rng.choice([0, 0, 2])
        lines, totals = build_lines(pick_lines(cust["buyerType"]), cust["stateCode"], discount)
        due = day + timedelta(days=cust["paymentTermsDays"])
        doc_id = f"doc-s{inv_seq:04d}"
        invoices.append(
            {
                "id": f"inv-{inv_seq:04d}",
                "number": number,
                "date": iso(day),
                "partyId": cust["id"],
                "docId": doc_id,
                "placeOfSupply": cust["stateCode"],
                "reverseCharge": False,
                "termsDays": cust["paymentTermsDays"],
                "dueDate": iso(due),
                "lines": lines,
                "totals": totals,
                "status": "posted",
            }
        )

# Keep roughly 300 invoices
assert 260 <= len(invoices) <= 360, len(invoices)

# ---------------------------------------------------------------- receipts

fy_purchases: dict[str, int] = {}
receipt_seq = 0


def pay_delay(profile: str) -> int:
    if profile == "prompt":
        return rng.randint(-6, 2)
    if profile == "steady":
        return rng.randint(-2, 14)
    if profile == "slow":
        return rng.randint(10, 48)
    return rng.randint(35, 120)


pending_receipts: dict[tuple[str, date], list[tuple[dict, int, int]]] = {}
for inv in invoices:
    cust = party_by_id[inv["partyId"]]
    profile = cust["_profile"]
    total = inv["totals"]["totalPaise"]
    due = date.fromisoformat(inv["dueDate"])

    tds = 0
    if cust["id"] in cat.TDS_DEDUCTING_CUSTOMERS:
        before = fy_purchases.get(cust["id"], 0)
        fy_purchases[cust["id"]] = before + inv["totals"]["taxablePaise"]
        if fy_purchases[cust["id"]] > 50_00_000_00:
            over = min(inv["totals"]["taxablePaise"], fy_purchases[cust["id"]] - 50_00_000_00)
            tds = bp_of(over, 10)

    pay_on = due + timedelta(days=pay_delay(profile))
    if profile == "chronic" and rng.random() < 0.35:
        pay_on = AS_OF + timedelta(days=30)
    partial = rng.random() < 0.12
    if partial:
        first = round_to_rupee((total - tds) * rng.choice([40, 50, 60]) // 100)
        first_on = due + timedelta(days=rng.randint(-3, 10))
        if first_on <= AS_OF:
            pending_receipts.setdefault((cust["id"], first_on), []).append((inv, first, 0))
            if pay_on <= AS_OF and pay_on > first_on:
                pending_receipts.setdefault((cust["id"], pay_on), []).append((inv, total - tds - first, tds))
            continue
    if pay_on <= AS_OF:
        pending_receipts.setdefault((cust["id"], pay_on), []).append((inv, total - tds, tds))

modes = ["NEFT", "RTGS", "UPI", "Cheque"]
for (cid, on), allocs in sorted(pending_receipts.items(), key=lambda kv: (kv[0][1], kv[0][0])):
    receipt_seq += 1
    amount = sum(a for _, a, _ in allocs)
    tds_total = sum(t for _, _, t in allocs)
    mode = "RTGS" if amount > 2_00_000_00 else rng.choice(modes)
    payments.append(
        {
            "id": f"rcpt-{receipt_seq:04d}",
            "date": iso(on),
            "partyId": cid,
            "direction": "in",
            "amountPaise": amount,
            "mode": mode,
            "reference": f"{mode[:3].upper()}{rng.randint(10**9, 10**10 - 1)}",
            "allocations": [
                {"invoiceId": inv["id"], "amountPaise": a, "tdsPaise": t} for inv, a, t in allocs
            ],
            "tdsDeductedPaise": tds_total,
            "tdsSection": "194Q" if tds_total else None,
        }
    )

# ---------------------------------------------------------------- purchases

bill_seq = 0
fy_vendor_purchase: dict[str, int] = {}


def vendor_lines(vendor: dict, target_paise: int) -> list[tuple[dict, int]]:
    pool = [s for c in cat.VENDOR_CATEGORIES[vendor["id"]] for s in skus_by_category[c]]
    chosen: dict[str, tuple[dict, int]] = {}
    running = 0
    candidates = rng.sample(pool, len(pool))
    while running < target_paise and len(chosen) < 7 and candidates:
        sku = candidates.pop()
        cost_unit = sku["costPaise"]
        qty = max(1, int((target_paise / 5) / cost_unit))
        if sku["unit"] == "MTR":
            qty = max(100, qty // 100 * 100)
        chosen[sku["id"]] = (sku, qty)
        running += qty * cost_unit
    return list(chosen.values())


def build_purchase_lines(chosen: list[tuple[dict, int]], vendor_state: str) -> list[dict]:
    lines = []
    intra = vendor_state == OUR_STATE
    for sku, qty in chosen:
        taxable = line_taxable(qty, sku["costPaise"], 0)
        rate = sku["gstRate"]
        cgst = sgst = igst = 0
        if intra:
            cgst = sgst = pct_of(taxable, rate * 50)
        else:
            igst = pct_of(taxable, rate * 100)
        lines.append(
            {
                "skuId": sku["id"],
                "description": sku["name"],
                "hsn": sku["hsn"],
                "qty": qty,
                "unit": sku["unit"],
                "ratePaise": sku["costPaise"],
                "discountPct": 0,
                "taxablePaise": taxable,
                "gstRate": rate,
                "cgstPaise": cgst,
                "sgstPaise": sgst,
                "igstPaise": igst,
            }
        )
    return lines


def service_line(description: str, sac: str, amount: int, rate: int, intra: bool) -> dict:
    cgst = sgst = igst = 0
    if rate:
        if intra:
            cgst = sgst = pct_of(amount, rate * 50)
        else:
            igst = pct_of(amount, rate * 100)
    return {
        "skuId": None,
        "description": description,
        "hsn": sac,
        "qty": 1,
        "unit": "OTH",
        "ratePaise": amount,
        "discountPct": 0,
        "taxablePaise": amount,
        "gstRate": rate,
        "cgstPaise": cgst,
        "sgstPaise": sgst,
        "igstPaise": igst,
    }


def add_bill(vendor: dict, on: date, lines: list[dict], number: str, kind: str, status: str = "posted") -> dict:
    global bill_seq
    bill_seq += 1
    totals = totals_of(lines)
    tds = None
    section = vendor.get("tdsSection")
    if section:
        base = totals["taxablePaise"]
        if section == "194Q":
            before = fy_vendor_purchase.get(vendor["id"], 0)
            fy_vendor_purchase[vendor["id"]] = before + base
            limit = 50_00_000_00
            if fy_vendor_purchase[vendor["id"]] > limit:
                over = min(base, fy_vendor_purchase[vendor["id"]] - limit)
                tds = {"section": section, "rateBp": vendor["tdsRateBp"], "basePaise": over, "amountPaise": bp_of(over, vendor["tdsRateBp"])}
        else:
            rate = vendor["tdsRateBp"]
            if vendor["id"] == "V06" and on.month in (7, 8, 9):
                rate = 200  # booked as technical services (2%) instead of professional fees (10%)
            tds = {"section": section, "rateBp": rate, "basePaise": base, "amountPaise": bp_of(base, rate)}
    bill = {
        "id": f"bill-{bill_seq:04d}",
        "number": number,
        "date": iso(on),
        "partyId": vendor["id"],
        "docId": f"doc-p{bill_seq:04d}",
        "kind": kind,
        "placeOfSupply": OUR_STATE,
        "lines": lines,
        "totals": totals,
        "itcEligible": bool(vendor["gstin"]),
        "tds": tds,
        "status": status,
    }
    bills.append(bill)
    return bill


goods_vendors = [party_by_id[v] for v in ("V01", "V02", "V03", "V04")]
month = FY_START
deccan_october_bill = None
while month <= AS_OF:
    for vendor in goods_vendors:
        per_month = {"V01": 3, "V02": 2, "V03": 2, "V04": 1}[vendor["id"]]
        for k in range(per_month):
            on = month + timedelta(days=rng.randint(2 + k * 9, 8 + k * 9))
            if on > AS_OF - timedelta(days=4):
                continue
            target = {"V01": 10, "V02": 7, "V03": 6, "V04": 5}[vendor["id"]] * 1_00_000_00
            lines = build_purchase_lines(vendor_lines(vendor, target), vendor["stateCode"])
            prefix = {"V01": "SCPL", "V02": "NSL", "V03": "DLC", "V04": "BFA"}[vendor["id"]]
            add_bill(vendor, on, lines, f"{prefix}/{on.strftime('%y%m')}/{rng.randint(100, 999)}", "goods")

    # The Deccan Lighting bill that never appears in GSTR-2B (vendor has not filed)
    if month.month == 10:
        deccan = party_by_id["V03"]
        panel = sku_by_id["SKU-303"]
        flood = sku_by_id["SKU-304"]
        special = [
            {**build_purchase_lines([(panel, 100)], deccan["stateCode"])[0], "ratePaise": 1_800_00, "taxablePaise": 1_80_000_00, "igstPaise": 32_400_00},
            {**build_purchase_lines([(flood, 20)], deccan["stateCode"])[0], "ratePaise": 1_611_11, "taxablePaise": 32_222_20, "igstPaise": 5_800_00},
        ]
        deccan_october_bill = add_bill(deccan, date(2026, 10, 18), special, "DLC/2610/488", "goods")

    services = [
        ("V05", "Freight and handling, {m}", "9965", 18, rng.randint(38, 52) * 1000_00),
        ("V06", "Accounting and tax retainer, {m}", "9982", 18, 25_000_00),
        ("V07", "Godown rent, Bhosari MIDC, {m}", "9972", 0, 1_20_000_00),
        ("V08", "Sales commission, {m}", "9961", 0, rng.randint(28, 41) * 1000_00),
    ]
    month_end = (month.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    on = month_end if month_end <= AS_OF else None
    if on:
        for vid, desc, sac, rate, amount in services:
            vendor = party_by_id[vid]
            line = service_line(desc.format(m=month.strftime("%b %Y")), sac, amount, rate, vendor["stateCode"] == OUR_STATE)
            number = f"{vid[1:]}/{month.strftime('%y%m')}/{rng.randint(10, 99)}"
            kind = {"V05": "service", "V06": "professional", "V07": "rent", "V08": "commission"}[vid]
            add_bill(vendor, on, [line], number, kind)
    month = (month.replace(day=28) + timedelta(days=4)).replace(day=1)

# Three bills that arrived in November, read by The Accountant and waiting for approval
for vid, days_ago in (("V01", 2), ("V02", 1), ("V05", 0)):
    vendor = party_by_id[vid]
    on = AS_OF - timedelta(days=days_ago)
    if vid == "V05":
        lines = [service_line("Freight and handling charges, 1 to 3 November 2026", "9965", 14_600_00, 18, True)]
        kind = "service"
    else:
        target = {"V01": 18, "V02": 9}[vid] * 1_00_000_00
        lines = build_purchase_lines(vendor_lines(vendor, target), vendor["stateCode"])
        kind = "goods"
    prefix = {"V01": "SCPL", "V02": "NSL", "V05": "05"}[vid]
    add_bill(vendor, on, lines, f"{prefix}/2611/{rng.randint(100, 999)}", kind, status="staged")

# Payments to vendors: everything up to October is paid, net of TDS
pay_seq = 0
for bill in bills:
    if bill["status"] != "posted":
        continue
    on = date.fromisoformat(bill["date"]) + timedelta(days=rng.randint(10, 35))
    if on > AS_OF:
        continue
    pay_seq += 1
    tds_amount = bill["tds"]["amountPaise"] if bill["tds"] else 0
    payments.append(
        {
            "id": f"pay-{pay_seq:04d}",
            "date": iso(on),
            "partyId": bill["partyId"],
            "direction": "out",
            "amountPaise": bill["totals"]["totalPaise"] - tds_amount,
            "mode": "RTGS" if bill["totals"]["totalPaise"] > 2_00_000_00 else "NEFT",
            "reference": f"UTR{rng.randint(10**11, 10**12 - 1)}",
            "allocations": [{"billId": bill["id"], "amountPaise": bill["totals"]["totalPaise"] - tds_amount, "tdsPaise": tds_amount}],
            "tdsDeductedPaise": tds_amount,
            "tdsSection": bill["tds"]["section"] if bill["tds"] else None,
        }
    )

payments.sort(key=lambda p: (p["date"], p["id"]))

# ---------------------------------------------------------------- documents

def doc_entry(doc_id: str, kind: str, ref_id: str, on: date, channel: str, sender: str | None, status: str) -> dict:
    return {
        "id": doc_id,
        "kind": kind,
        "refId": ref_id,
        "file": f"/docs/{doc_id}.pdf",
        "pages": 1,
        "receivedAt": stamp(on, rng.randint(9, 18), rng.randint(0, 59)),
        "channel": channel,
        "from": sender,
        "status": status,
        "regions": [],
    }


for inv in invoices:
    documents.append(doc_entry(inv["docId"], "sales_invoice", inv["id"], date.fromisoformat(inv["date"]), "generated", None, "posted"))
for bill in bills:
    vendor = party_by_id[bill["partyId"]]
    channel = rng.choice(["email", "email", "email", "upload"])
    documents.append(
        doc_entry(bill["docId"], "purchase_bill", bill["id"], date.fromisoformat(bill["date"]), channel, vendor["contact"]["email"] if channel == "email" else None, bill["status"])
    )

# ---------------------------------------------------------------- GST returns


def r2(paise: int) -> float:
    return round(paise / 100, 2)


def gstr1_for(period: date, skip_invoice: str | None = None) -> dict:
    rows: dict[str, list] = {}
    hsn: dict[tuple, dict] = {}
    for inv in invoices:
        d = date.fromisoformat(inv["date"])
        if (d.year, d.month) != (period.year, period.month) or inv["id"] == skip_invoice:
            continue
        cust = party_by_id[inv["partyId"]]
        by_rate: dict[int, dict] = {}
        for l in inv["lines"]:
            b = by_rate.setdefault(l["gstRate"], {"txval": 0, "iamt": 0, "camt": 0, "samt": 0})
            b["txval"] += l["taxablePaise"]
            b["iamt"] += l["igstPaise"]
            b["camt"] += l["cgstPaise"]
            b["samt"] += l["sgstPaise"]
            key = (l["hsn"], l["unit"], l["gstRate"])
            h = hsn.setdefault(key, {"qty": 0, "txval": 0, "iamt": 0, "camt": 0, "samt": 0, "desc": sku_by_id[l["skuId"]]["category"]})
            h["qty"] += l["qty"]
            h["txval"] += l["taxablePaise"]
            h["iamt"] += l["igstPaise"]
            h["camt"] += l["cgstPaise"]
            h["samt"] += l["sgstPaise"]
        rows.setdefault(cust["gstin"], []).append(
            {
                "inum": inv["number"],
                "idt": d.strftime("%d-%m-%Y"),
                "val": r2(inv["totals"]["totalPaise"]),
                "pos": inv["placeOfSupply"],
                "rchrg": "N",
                "inv_typ": "R",
                "itms": [
                    {"num": rate * 100 + 1, "itm_det": {"rt": rate, "txval": r2(v["txval"]), "iamt": r2(v["iamt"]), "camt": r2(v["camt"]), "samt": r2(v["samt"]), "csamt": 0}}
                    for rate, v in sorted(by_rate.items())
                ],
            }
        )
    return {
        "gstin": cat.BUSINESS["gstin"],
        "fp": period.strftime("%m%Y"),
        "b2b": [{"ctin": ctin, "inv": inv_rows} for ctin, inv_rows in sorted(rows.items())],
        "hsn": {
            "data": [
                {"num": i + 1, "hsn_sc": k[0], "desc": v["desc"], "uqc": k[1], "qty": v["qty"], "rt": k[2], "txval": r2(v["txval"]), "iamt": r2(v["iamt"]), "camt": r2(v["camt"]), "samt": r2(v["samt"]), "csamt": 0}
                for i, (k, v) in enumerate(sorted(hsn.items()))
            ]
        },
    }


def gstr2b_for(period: date, exclude: set[str]) -> dict:
    entries = []
    for bill in bills:
        d = date.fromisoformat(bill["date"])
        vendor = party_by_id[bill["partyId"]]
        if (d.year, d.month) != (period.year, period.month) or not vendor["gstin"] or bill["id"] in exclude or bill["status"] != "posted":
            continue
        t = bill["totals"]
        entries.append(
            {"ctin": vendor["gstin"], "trdnm": vendor["name"], "inum": bill["number"], "idt": d.strftime("%d-%m-%Y"), "val": r2(t["totalPaise"]), "txval": r2(t["taxablePaise"]), "iamt": r2(t["igstPaise"]), "camt": r2(t["cgstPaise"]), "samt": r2(t["sgstPaise"])}
        )
    return {"gstin": cat.BUSINESS["gstin"], "rtnprd": period.strftime("%m%Y"), "docdata": {"b2b": entries}}


def gstr3b_for(period: date, skip_invoice: str | None, itc_bills: list[dict]) -> dict:
    out = {"txval": 0, "iamt": 0, "camt": 0, "samt": 0}
    for inv in invoices:
        d = date.fromisoformat(inv["date"])
        if (d.year, d.month) != (period.year, period.month) or inv["id"] == skip_invoice:
            continue
        t = inv["totals"]
        out["txval"] += t["taxablePaise"]
        out["iamt"] += t["igstPaise"]
        out["camt"] += t["cgstPaise"]
        out["samt"] += t["sgstPaise"]
    itc = {"iamt": 0, "camt": 0, "samt": 0}
    for bill in itc_bills:
        t = bill["totals"]
        itc["iamt"] += t["igstPaise"]
        itc["camt"] += t["cgstPaise"]
        itc["samt"] += t["sgstPaise"]
    return {
        "gstin": cat.BUSINESS["gstin"],
        "ret_period": period.strftime("%m%Y"),
        "sup_details": {"osup_det": {k: r2(v) for k, v in out.items()} | {"csamt": 0}},
        "itc_elg": {"itc_avl": [{"ty": "OTH", **{k: r2(v) for k, v in itc.items()}, "csamt": 0}]},
    }


def bills_in(period: date, exclude: set[str] = frozenset()) -> list[dict]:
    out = []
    for bill in bills:
        d = date.fromisoformat(bill["date"])
        if (d.year, d.month) == (period.year, period.month) and bill["itcEligible"] and bill["id"] not in exclude and bill["status"] == "posted":
            out.append(bill)
    return out


filed_returns = []
gstr2b = []
oct_invoices = [i for i in invoices if i["date"].startswith("2026-10")]
missed_invoice = sorted(oct_invoices, key=lambda i: i["totals"]["totalPaise"])[len(oct_invoices) // 2]

m = FY_START
while m < date(2026, 11, 1):
    is_oct = m.month == 10
    skip = missed_invoice["id"] if is_oct else None
    exclude_2b = {deccan_october_bill["id"]} if is_oct else set()
    next_month = (m.replace(day=28) + timedelta(days=4)).replace(day=1)
    for form, due_day, data in (("GSTR-1", 11, gstr1_for(m, skip)), ("GSTR-3B", 20, gstr3b_for(m, skip, bills_in(m)))):
        due = next_month.replace(day=due_day)
        filed = due <= AS_OF
        filed_returns.append(
            {
                "id": f"{form.lower().replace('-', '')}-{m:%Y-%m}",
                "form": form,
                "period": f"{m:%Y-%m}",
                "status": "filed" if filed else "draft",
                "filedOn": iso(due - timedelta(days=1)) if filed else None,
                "sharedOn": None if filed else "2026-11-03",
                "dueOn": iso(due),
                "filedBy": cat.BUSINESS["accountantFirm"],
                "data": data,
            }
        )
    gstr2b.append({"period": f"{m:%Y-%m}", "data": gstr2b_for(m, exclude_2b)})
    m = next_month

# ---------------------------------------------------------------- TDS returns (26Q) and Form 26AS


def quarter_of(d: date) -> str:
    q = {4: 1, 5: 1, 6: 1, 7: 2, 8: 2, 9: 2, 10: 3, 11: 3, 12: 3, 1: 4, 2: 4, 3: 4}[d.month]
    return f"FY2026-27-Q{q}"


tds_filed: dict[str, list] = {}
for pay in payments:
    if pay["direction"] != "out" or not pay["tdsDeductedPaise"]:
        continue
    bill = next(b for b in bills if b["id"] == pay["allocations"][0]["billId"])
    d = date.fromisoformat(bill["date"])  # TDS is due on credit, which here precedes payment
    q = quarter_of(d)
    if q not in ("FY2026-27-Q1", "FY2026-27-Q2"):
        continue
    vendor = party_by_id[bill["partyId"]]
    deducted = pay["tdsDeductedPaise"]
    if q == "FY2026-27-Q2" and vendor["id"] == "V07" and bill["date"].startswith("2026-08"):
        continue  # August rent deduction left out of the return
    tds_filed.setdefault(q, []).append(
        {"section": bill["tds"]["section"], "deducteePan": vendor["pan"], "deducteeName": vendor["name"], "billId": bill["id"], "paidOn": pay["date"], "amountPaidPaise": bill["tds"]["basePaise"], "tdsPaise": deducted, "depositedOn": iso((d.replace(day=28) + timedelta(days=4)).replace(day=7))}
    )
for q, rows in tds_filed.items():
    filed_on = "2026-07-30" if q.endswith("Q1") else "2026-10-30"
    filed_returns.append(
        {
            "id": f"26q-{q}",
            "form": "26Q",
            "period": q,
            "status": "filed",
            "filedOn": filed_on,
            "sharedOn": None,
            "dueOn": "2026-07-31" if q.endswith("Q1") else "2026-10-31",
            "filedBy": cat.BUSINESS["accountantFirm"],
            "data": {"tan": cat.BUSINESS["tan"], "quarter": q, "deductions": rows},
        }
    )

form26as = []
skipped_sahyog = False
invoice_by_id = {i["id"]: i for i in invoices}
for pay in payments:
    if pay["direction"] != "in" or not pay["tdsDeductedPaise"]:
        continue
    cust = party_by_id[pay["partyId"]]
    for alloc in pay["allocations"]:
        if not alloc["tdsPaise"]:
            continue
        inv = invoice_by_id[alloc["invoiceId"]]
        q = quarter_of(date.fromisoformat(inv["date"]))  # the buyer deducts when it books our invoice
        if q == "FY2026-27-Q3":
            continue  # the Q3 return is not due until 31 January
        if cust["id"] == "C25" and q == "FY2026-27-Q2" and not skipped_sahyog:
            skipped_sahyog = True  # Sahyog left this deduction out of its return
            continue
        form26as.append(
            {
                "quarter": q,
                "deductorTan": cust["tan"],
                "deductorName": cust["name"],
                "section": "194Q",
                "invoiceId": inv["id"],
                "receiptId": pay["id"],
                "creditedOn": inv["date"],
                "amountPaidPaise": inv["totals"]["taxablePaise"],
                "tdsCreditedPaise": alloc["tdsPaise"],
            }
        )

# ---------------------------------------------------------------- whole office

import office  # noqa: E402
from pdfs import render_bill, render_sales_invoice  # noqa: E402

rest = office.build(rng, cat.BUSINESS, parties, skus, invoices, bills, cat.EMPLOYEES, AS_OF, build_lines)

# The document that arrived at 17:40 is still being read
for doc in documents:
    if doc["id"] == next(b["docId"] for b in bills if b["status"] == "staged" and b["partyId"] == "V05"):
        doc["status"] = "reading"
        doc["receivedAt"] = stamp(AS_OF, 17, 40)

# ---------------------------------------------------------------- PDFs

PDF_OUT.mkdir(parents=True, exist_ok=True)
doc_by_id = {d["id"]: d for d in documents}
for inv in invoices:
    doc_by_id[inv["docId"]]["regions"] = render_sales_invoice(PDF_OUT / f"{inv['docId']}.pdf", inv, party_by_id[inv["partyId"]], cat.BUSINESS, cat.STATES)
for bill in bills:
    doc_by_id[bill["docId"]]["regions"] = render_bill(PDF_OUT / f"{bill['docId']}.pdf", bill, party_by_id[bill["partyId"]], cat.BUSINESS, cat.STATES)

# A document still being read has a PDF but nothing in the books yet: no bill,
# no regions and no approval card. Reading it is the Accountant's next job.
for doc in documents:
    if doc["status"] == "reading":
        bills = [b for b in bills if b["docId"] != doc["id"]]
        rest["staged"] = [s for s in rest["staged"] if not any(e["ref"].get("id") == doc["id"] for e in s["evidence"])]
        doc["refId"] = None
        doc["regions"] = []

# ---------------------------------------------------------------- write


def public(record: dict) -> dict:
    return {k: v for k, v in record.items() if not k.startswith("_")}


out = {
    "seed": SEED,
    "generatedFor": iso(AS_OF),
    "business": cat.BUSINESS,
    "states": cat.STATES,
    "parties": [public(p) for p in parties],
    "skus": skus,
    "documents": documents,
    "invoices": invoices,
    "bills": bills,
    "payments": payments,
    "filedReturns": filed_returns,
    "gstr2b": gstr2b,
    "form26as": form26as,
    **rest,
}
DATA_OUT.parent.mkdir(parents=True, exist_ok=True)
DATA_OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))

monthly: dict[str, int] = {}
for inv in invoices:
    monthly[inv["date"][:7]] = monthly.get(inv["date"][:7], 0) + inv["totals"]["taxablePaise"]
print(f"invoices {len(invoices)}, bills {len(bills)}, payments {len(payments)}, documents {len(documents)}")
print("monthly taxable sales (lakh):", {k: round(v / 1e7, 1) for k, v in monthly.items()})
print(f"missed invoice in October draft: {missed_invoice['number']}  deccan bill: {deccan_october_bill['number']} igst {deccan_october_bill['totals']['igstPaise']}")
print(f"wrote {DATA_OUT.relative_to(ROOT)} ({DATA_OUT.stat().st_size // 1024} KB)")

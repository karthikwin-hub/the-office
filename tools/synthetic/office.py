"""Records for the rest of the office: sales, marketing, social, operations, people,
and what each agent has been doing today."""

from __future__ import annotations

from datetime import date, datetime, timedelta

from money import inr
from social import build_social


def rupees(paise: int) -> str:
    """Amounts in UI text use the rupee sign; only the printed PDFs fall back to Rs."""
    s = inr(paise)
    return "\u20b9" + (s[:-3] if s.endswith(".00") else s)

AGENT_STATES = [
    # id, hired, trust level, hired on, checked, correct
    ("office-manager", True, "trusted", "2026-06-02", 318, 311),
    ("accountant", True, "trusted", "2026-06-02", 1146, 1139),
    ("credit-controller", True, "trainee", "2026-08-18", 142, 138),
    ("tax-clerk", True, "trusted", "2026-06-02", 96, 96),
    ("auditor", True, "trainee", "2026-09-01", 41, 40),
    ("sales-rep", True, "trainee", "2026-09-22", 64, 57),
    ("quote-desk", True, "trusted", "2026-07-10", 188, 186),
    ("account-manager", False, "trainee", None, 0, 0),
    ("marketer", True, "trainee", "2026-10-01", 22, 19),
    ("market-watcher", False, "trainee", None, 0, 0),
    ("social-media-manager", True, "trainee", "2026-10-01", 58, 51),
    ("storekeeper", True, "trusted", "2026-07-10", 402, 399),
    ("buyer", False, "trainee", None, 0, 0),
    ("compliance-officer", True, "trusted", "2026-06-02", 74, 74),
    ("payroll-clerk", False, "trainee", None, 0, 0),
]


def at(d: date, hh: int, mm: int) -> str:
    return datetime(d.year, d.month, d.day, hh, mm).isoformat() + "+05:30"


def build(rng, business, parties, skus, invoices, bills, employees_src, as_of: date, build_lines):
    sku = {s["id"]: s for s in skus}
    customers = [p for p in parties if p["kind"] == "customer"]
    party = {p["id"]: p for p in parties}

    # ------------------------------------------------------------ sales
    lead_rows = [
        ("Ostwal Realty", "Pune", "IndiaMART", "quoted", 18_40_000, "Armoured cable and DBs for a 6-storey residential block"),
        ("Mahalaxmi Hospital", "Kolhapur", "Referral", "contacted", 9_80_000, "LED panels and changeover for the new OPD wing"),
        ("Sinhgad Engineering College", "Pune", "Website", "new", 6_20_000, "Lab rewiring, MCBs and conduit"),
        ("Greenfield Agro Processors", "Baramati", "Dealer meet", "quoted", 12_75_000, "Industrial lighting and 25 sq mm armoured cable"),
        ("Shree Datta Steel", "Jalna", "IndiaMART", "new", 4_10_000, "Contactor and isolator replacement"),
        ("Nirmal Resorts", "Lonavala", "Walk-in", "contacted", 7_45_000, "Solar street lights for the campus road"),
        ("Bhagwati Textiles", "Ichalkaranji", "Referral", "won", 5_90_000, "Exhaust fans and BLDC fans for the weaving shed"),
        ("Vasundhara Housing Society", "Pune", "Website", "lost", 2_80_000, "Common area LED retrofit; went with a local electrician"),
        ("Ambika Cold Storage", "Nashik", "IndiaMART", "contacted", 8_30_000, "Stabilisers and UPS for the control room"),
        ("Metro Interiors", "Mumbai", "Instagram", "new", 3_60_000, "Downlights and modular switches for office fit-outs"),
        ("Sai Krupa Builders", "Satara", "Dealer meet", "quoted", 14_20_000, "Wiring package for 48 flats"),
        ("Rajhans Hotels", "Aurangabad", "Referral", "new", 5_10_000, "Fans and lighting refresh across 60 rooms"),
        ("Kapse Agro Pumps", "Sangli", "IndiaMART", "lost", 1_90_000, "Price-led enquiry; competitor quoted 9% lower"),
        ("Orchid Schools Trust", "Pune", "Website", "contacted", 6_80_000, "Classroom fans and LED battens, two campuses"),
        ("Pratik Polymers", "Chakan", "Walk-in", "won", 3_25_000, "Power contactors and cable ties"),
        ("Yashwant Co-op Bank", "Karad", "Referral", "new", 2_40_000, "UPS and batteries for six branches"),
        ("Sahyadri Solar EPC", "Pune", "IndiaMART", "quoted", 21_50_000, "Solar inverters and PV modules for rooftop projects"),
        ("Kalyani Warehousing", "Bhiwandi", "Website", "contacted", 9_10_000, "Floodlights and street lights for yard"),
    ]
    leads = []
    for i, (name, city, source, stage, value, need) in enumerate(lead_rows):
        created = as_of - timedelta(days=rng.randint(2, 60))
        touched = min(as_of, created + timedelta(days=rng.randint(0, 20)))
        leads.append(
            {
                "id": f"lead-{i + 1:03d}",
                "name": name,
                "city": city,
                "source": source,
                "stage": stage,
                "valuePaise": value * 100,
                "need": need,
                "createdOn": created.isoformat(),
                "lastTouchOn": touched.isoformat(),
                "nextStep": {
                    "new": "Call to qualify budget and timeline",
                    "contacted": "Send catalogue and site visit slot",
                    "quoted": "Follow up on quotation",
                    "won": "Hand over to dispatch",
                    "lost": "Close with reason recorded",
                }[stage],
            }
        )

    quotes = []
    quote_targets = [
        ("lead-001", None, "sent", ["SKU-106", "SKU-107", "SKU-205", "SKU-202"]),
        ("lead-004", None, "sent", ["SKU-304", "SKU-305", "SKU-107"]),
        ("lead-011", None, "draft", ["SKU-102", "SKU-103", "SKU-201", "SKU-206", "SKU-207", "SKU-501"]),
        ("lead-017", None, "sent", ["SKU-308", "SKU-309"]),
        (None, "C03", "accepted", ["SKU-106", "SKU-203", "SKU-205"]),
        (None, "C13", "draft", ["SKU-107", "SKU-204", "SKU-208"]),
        (None, "C21", "expired", ["SKU-303", "SKU-306", "SKU-302"]),
        (None, "C17", "accepted", ["SKU-103", "SKU-104", "SKU-202"]),
    ]
    for i, (lead_id, party_id, status, sku_ids) in enumerate(quote_targets):
        on = as_of - timedelta(days=rng.randint(1, 25))
        chosen = [(sku[s], 300 if sku[s]["unit"] == "MTR" else rng.randint(10, 80)) for s in sku_ids]
        if party_id == "C13":
            chosen = [(sku["SKU-107"], 1200), (sku["SKU-204"], 18), (sku["SKU-208"], 12)]
        pos = party[party_id]["stateCode"] if party_id else "27"
        lines, totals = build_lines(chosen, pos, 3)
        quotes.append(
            {
                "id": f"quote-{i + 1:03d}",
                "number": f"KE/Q/26-27/{41 + i:03d}",
                "date": on.isoformat(),
                "leadId": lead_id,
                "partyId": party_id,
                "status": status,
                "validUntil": (on + timedelta(days=15)).isoformat(),
                "lines": lines,
                "totals": totals,
            }
        )

    # ------------------------------------------------------------ marketing
    campaigns = [
        {"id": "camp-01", "name": "Diwali dealer scheme on fans", "channel": "WhatsApp broadcast", "skuIds": ["SKU-401", "SKU-402"], "status": "ended", "start": "2026-10-01", "end": "2026-10-25", "budgetPaise": 45_000_00, "spentPaise": 41_200_00, "reach": 1860, "enquiries": 74, "attributedSalesPaise": 18_60_000_00},
        {"id": "camp-02", "name": "Solar rooftop kits for contractors", "channel": "IndiaMART promotion", "skuIds": ["SKU-308", "SKU-309", "SKU-307"], "status": "running", "start": "2026-10-15", "end": "2026-11-30", "budgetPaise": 60_000_00, "spentPaise": 22_800_00, "reach": 5400, "enquiries": 31, "attributedSalesPaise": 4_10_000_00},
        {"id": "camp-03", "name": "Pune electricians' meet, Bhosari", "channel": "Dealer meet", "skuIds": ["SKU-203", "SKU-205"], "status": "planned", "start": "2026-11-22", "end": "2026-11-22", "budgetPaise": 85_000_00, "spentPaise": 0, "reach": 0, "enquiries": 0, "attributedSalesPaise": 0},
        {"id": "camp-04", "name": "Google Business posts: LED retrofit", "channel": "Google Business Profile", "skuIds": ["SKU-303", "SKU-306"], "status": "running", "start": "2026-09-01", "end": "2026-12-31", "budgetPaise": 0, "spentPaise": 0, "reach": 12_300, "enquiries": 46, "attributedSalesPaise": 6_80_000_00},
        {"id": "camp-05", "name": "Clear slow stock: MCCB and pedestal fans", "channel": "WhatsApp broadcast", "skuIds": ["SKU-204", "SKU-404"], "status": "draft", "start": "2026-11-10", "end": "2026-11-30", "budgetPaise": 15_000_00, "spentPaise": 0, "reach": 0, "enquiries": 0, "attributedSalesPaise": 0},
        {"id": "camp-06", "name": "Monsoon safety: RCCB awareness", "channel": "Instagram", "skuIds": ["SKU-203"], "status": "ended", "start": "2026-06-10", "end": "2026-07-31", "budgetPaise": 30_000_00, "spentPaise": 29_400_00, "reach": 21_700, "enquiries": 58, "attributedSalesPaise": 9_20_000_00},
    ]
    calendar = [
        {"date": "2026-11-14", "name": "Children's Day", "relevance": "Low: no trade link"},
        {"date": "2026-11-24", "name": "Tulsi Vivah, start of wedding season", "relevance": "High: house wiring and lighting demand rises through February"},
        {"date": "2026-12-25", "name": "Christmas and year-end closing", "relevance": "Medium: contractors close projects before 31 March billing"},
        {"date": "2027-01-14", "name": "Makar Sankranti", "relevance": "Medium: dealer gifting and schemes"},
        {"date": "2027-03-22", "name": "Gudi Padwa", "relevance": "High: new home purchases in Maharashtra"},
    ]
    marketplaces = ["IndiaMART", "Moglix", "Industrybuying", "Amazon Business"]
    competitor_prices = []
    for sid in ["SKU-102", "SKU-103", "SKU-106", "SKU-202", "SKU-203", "SKU-303", "SKU-401", "SKU-402", "SKU-308", "SKU-602"]:
        s = sku[sid]
        for mk in rng.sample(marketplaces, 3):
            competitor_prices.append(
                {"skuId": sid, "marketplace": mk, "seller": rng.choice(["Ganesh Electricals", "VoltMart", "Shakti Traders", "PowerKart", "Om Sai Electric"]), "pricePaise": int(s["pricePaise"] * rng.uniform(0.9, 1.12)), "seenOn": (as_of - timedelta(days=rng.randint(0, 3))).isoformat()}
            )

    # ------------------------------------------------------------ social media
    social = build_social(sku, party, invoices, leads, quotes, as_of)
    posts, inbox = social["posts"], social["socialInbox"]

    # ------------------------------------------------------------ operations
    sold: dict[str, int] = {}
    for inv in invoices:
        for l in inv["lines"]:
            sold[l["skuId"]] = sold.get(l["skuId"], 0) + l["qty"]
    stock = []
    for s in skus:
        monthly = sold.get(s["id"], 0) / 7.1
        on_hand = int(monthly * rng.uniform(0.4, 2.2))
        if s["id"] in ("SKU-109", "SKU-204", "SKU-404", "SKU-308", "SKU-603"):
            on_hand = int(max(monthly, 4) * rng.uniform(5, 9))
        lead = rng.choice([4, 7, 7, 10, 14, 21])
        reorder = int(monthly / 30 * (lead + 7)) + 1
        if s["id"] in ("SKU-103", "SKU-202", "SKU-303", "SKU-402"):
            on_hand = int(reorder * 0.6)
        stock.append({"skuId": s["id"], "onHand": on_hand, "reorderPoint": reorder, "leadTimeDays": lead, "location": "Bhosari godown", "lastReceivedOn": (as_of - timedelta(days=rng.randint(2, 40))).isoformat()})

    low = [st for st in stock if st["onHand"] <= st["reorderPoint"]]
    purchase_orders = [
        {"id": "po-01", "number": "KE/PO/26-27/112", "vendorId": "V01", "date": (as_of - timedelta(days=9)).isoformat(), "status": "received", "lines": [{"skuId": "SKU-102", "qty": 400, "ratePaise": sku["SKU-102"]["costPaise"]}, {"skuId": "SKU-501", "qty": 3000, "ratePaise": sku["SKU-501"]["costPaise"]}]},
        {"id": "po-02", "number": "KE/PO/26-27/113", "vendorId": "V02", "date": (as_of - timedelta(days=3)).isoformat(), "status": "sent", "lines": [{"skuId": "SKU-201", "qty": 1200, "ratePaise": sku["SKU-201"]["costPaise"]}]},
        {"id": "po-03", "number": "KE/PO/26-27/114", "vendorId": "V03", "date": as_of.isoformat(), "status": "draft", "lines": [{"skuId": st["skuId"], "qty": max(st["reorderPoint"] * 2, 20), "ratePaise": sku[st["skuId"]]["costPaise"]} for st in low if sku[st["skuId"]]["category"] in ("Lighting",)][:3] or [{"skuId": "SKU-303", "qty": 120, "ratePaise": sku["SKU-303"]["costPaise"]}]},
    ]
    for po in purchase_orders:
        po["totalPaise"] = sum(l["qty"] * l["ratePaise"] for l in po["lines"])
    rfqs = [
        {"id": "rfq-01", "title": "BLDC ceiling fans, 300 pieces", "skuId": "SKU-402", "qty": 300, "quotes": [
            {"vendorName": "Bharat Fans & Appliances", "ratePaise": 2_710_00, "leadDays": 10, "terms": "30 days credit"},
            {"vendorName": "Ujala Home Appliances", "ratePaise": 2_640_00, "leadDays": 21, "terms": "Advance payment"},
            {"vendorName": "Swift Air Products", "ratePaise": 2_790_00, "leadDays": 7, "terms": "45 days credit"},
        ]},
        {"id": "rfq-02", "title": "RCCB 4 pole 63 A, 150 pieces", "skuId": "SKU-203", "qty": 150, "quotes": [
            {"vendorName": "Narmada Switchgear Ltd", "ratePaise": 3_020_00, "leadDays": 7, "terms": "30 days credit"},
            {"vendorName": "Volta Protect", "ratePaise": 2_960_00, "leadDays": 14, "terms": "15 days credit"},
        ]},
    ]
    # Tracking for the calendar the Compliance Officer works out: what was filed, who has what, and one item added by hand.
    def track(rule, period, form, date, description, authority, **kw):
        status = "done" if kw.get("filedOn") else "upcoming"
        return {"id": f"{rule}:{period}", "date": date, "form": form, "description": description, "authority": authority, "status": status, "ruleId": rule, "period": period, "source": "rule", "updatedBy": kw.pop("by", "Rajesh Mehta"), "updatedAt": kw.pop("at", f"{kw.get('filedOn', '2026-11-03')}T18:10:00+05:30"), **kw}

    compliance = [
        track("advance-tax", "2026-27-15", "Advance tax", "2026-06-15", "Advance tax, first instalment", "Income Tax", filedOn="2026-06-13", ack="CIN 0510308 13062026 41102"),
        track("advance-tax", "2026-27-45", "Advance tax", "2026-09-15", "Advance tax, second instalment", "Income Tax", filedOn="2026-09-14", ack="CIN 0510308 14092026 52817"),
        track("tds-deposit", "2026-09", "TDS challan", "2026-10-07", "Deposit TDS deducted in September", "Income Tax", filedOn="2026-10-06", ack="CIN 0510308 06102026 30441"),
        track("ims", "2026-09", "IMS", "2026-10-14", "Review purchase invoices on IMS", "GST", filedOn="2026-10-13"),
        track("pf", "2026-09", "PF ECR", "2026-10-15", "Provident fund for September", "EPFO", filedOn="2026-10-14", ack="TRRN 1022610004417"),
        track("esi", "2026-09", "ESI", "2026-10-15", "ESI for September", "ESIC", filedOn="2026-10-14", ack="ESIC challan 22102026118"),
        track("tax-audit", "2025-26", "Form 3CA-3CD", "2026-10-21", "Tax audit report for FY 2025-26", "Income Tax", filedOn="2026-10-18", ack="ACK 714398220181026", assignee="ca"),
        track("aoc4", "2025-26", "AOC-4 XBRL", "2026-12-31", "Financial statements for FY 2025-26", "MCA", filedOn="2026-10-24", ack="AB1234567", assignee="cs",
              srn={"number": "AB1234567", "createdOn": "2026-10-24", "challan": "", "status": "approved", "remarks": "", "resubmitBy": None}),
        track("msme1", "2026-27-H1", "MSME-1", "2026-10-31", "Dues to micro and small suppliers, April to September", "MCA", filedOn="2026-10-29", ack="AB2209183", assignee="cs"),
        track("mgt7", "2025-26", "MGT-7", "2027-01-31", "Annual return for FY 2025-26", "MCA", assignee="cs", progress="preparing", by="Rajesh Mehta"),
        track("itr", "2025-26", "ITR-6", "2026-11-21", "Company income-tax return for FY 2025-26", "Income Tax", assignee="ca", progress="ready", by="Rajesh Mehta"),
        {"id": "man-20261101-1", "date": "2026-11-30", "form": "Factory licence", "description": "Renew the factory licence with DISH Maharashtra", "authority": "State", "status": "upcoming", "source": "manual", "assignee": "owner", "updatedBy": "Anil Kaveri", "updatedAt": "2026-11-01T11:20:00+05:30"},
    ]

    # ------------------------------------------------------------ people
    employees = []
    for eid, name, role, gross in employees_src:
        leave = rng.choice([0, 0, 1, 1, 2, 3])
        absent = rng.choice([0, 0, 0, 1])
        employees.append({"id": eid, "name": name, "role": role, "monthlyGrossPaise": gross * 100, "joinedOn": f"20{rng.randint(15, 25)}-{rng.randint(1, 12):02d}-01", "pan": None, "attendance": {"period": "2026-10", "workingDays": 26, "present": 26 - leave - absent, "paidLeave": leave, "unpaidAbsence": absent}})

    # ------------------------------------------------------------ agents
    agents = [
        {"agentId": a, "hired": h, "trustLevel": t, "hiredOn": on, "accuracy": {"checked": c, "correct": k}} for a, h, t, on, c, k in AGENT_STATES
    ]

    nov_bills = [b for b in bills if b["status"] == "staged"]
    today_invoices = [i for i in invoices if i["date"] == as_of.isoformat()]
    latest = sorted(invoices, key=lambda i: i["number"])[-6:]

    log = []

    def add(hh, mm, agent, text, kind=None, ref=None, d=as_of):
        log.append({"id": f"log-{len(log) + 1:03d}", "at": at(d, hh, mm), "agentId": agent, "text": text, "ref": {"kind": kind, "id": ref} if kind else None})

    add(8, 30, "compliance-officer", "Checked the filing calendar: TDS deducted in October is due on 7 November.", "compliance", "tds-deposit:2026-10")
    add(8, 45, "office-manager", "Prepared the morning digest and emailed it to Anil Kaveri.")
    for i, b in enumerate(nov_bills):
        vendor = party[b["partyId"]]
        add(9, 5 + i * 9, "accountant", f"Read bill {b['number']} from {vendor['name']}, {rupees(b['totals']['totalPaise'])}. Waiting for your approval before posting.", "document", b["docId"])
    for i, inv in enumerate(latest[-3:]):
        add(9, 50 + i * 4, "accountant", f"Filed a copy of invoice {inv['number']} for {party[inv['partyId']]['name']}.", "document", inv["docId"])
    add(10, 12, "storekeeper", f"{len(low)} SKUs are at or below their reorder point. Drafted a purchase order for lighting stock.", "purchase_order", "po-03")
    add(10, 30, "credit-controller", "Ran the morning ageing check and drafted reminders for overdue invoices.", "report", "ageing")
    add(10, 44, "tax-clerk", "Prepared the October GSTR-1 file from the books: ready for Mehta & Associates.", "return", "gstr1-2026-10")
    add(10, 58, "auditor", "Compared the accountant's October drafts with the books. Found differences to review.", "audit", "2026-10")
    add(9, 20, "social-media-manager", "Passed @sparkline_electricals' enquiry on Instagram to the Sales Rep.", "lead", "lead-msg-02")
    add(10, 5, "social-media-manager", "Passed a WhatsApp enquiry for 50 MCBs to the Sales Rep. The free reply window closes tomorrow morning.", "lead", "lead-msg-08")
    add(11, 20, "social-media-manager", "Drafted replies to 8 new comments, messages and reviews, including a 2-star review about counter waiting time.", "social", "msg-01")
    add(11, 30, "social-media-manager", "Held back \"Pedestal fans while stock lasts\": the Instagram text changed after you approved the calendar.", "post", "post-07")
    add(13, 10, "social-media-manager", "X is limiting posts, so I stopped publishing there. Posts for X are ready to post by hand.", "channel", "ch-x")
    add(11, 41, "quote-desk", "Drafted quotation KE/Q/26-27/046 for Kale Constructions.", "quote", "quote-006")
    add(11, 52, "office-manager", "Flagged to the Quote Desk: Kale Constructions already has invoices more than 60 days overdue.", "party", "C13")
    add(12, 15, "sales-rep", "Qualified Sinhgad Engineering College: budget confirmed, decision expected by 20 November.", "lead", "lead-003")
    add(12, 40, "marketer", "Pedestal fans and MCCBs have not moved in 60 days. Drafted a WhatsApp scheme to clear them.", "campaign", "camp-05")
    add(14, 5, "credit-controller", "Sharma Traders paid part of an older invoice. Updated their ageing.", "party", "C01")
    add(15, 10, "accountant", "Matched 6 bank receipts to open invoices.")
    add(16, 25, "sales-rep", "Followed up with Ostwal Realty on their quotation. They asked for a revised delivery schedule.", "lead", "lead-001")
    add(17, 2, "social-media-manager", "Scheduled \"Wedding-season lighting\" for Instagram, Facebook and Threads tomorrow.", "post", "post-05")
    add(17, 20, "social-media-manager", "Drafted the December calendar: 13 posts.", "calendar", "cal-2026-12")
    add(17, 40, "accountant", "Received a document by email from billing@konkanlogistics.in. Reading it now.", "document", nov_bills[-1]["docId"] if nov_bills else None)
    log.sort(key=lambda e: e["at"])

    staged = []

    def stage(agent, kind, title, summary, evidence, payload, created):
        staged.append({"id": f"chg-{len(staged) + 1:03d}", "agentId": agent, "kind": kind, "createdAt": created, "title": title, "summary": summary, "evidence": evidence, "payload": payload, "status": "pending"})

    for i, b in enumerate(nov_bills):
        vendor = party[b["partyId"]]
        t = b["totals"]
        tax = t["cgstPaise"] + t["sgstPaise"] + t["igstPaise"]
        stage(
            "accountant",
            "ledger_entry",
            f"Post bill {b['number']} from {vendor['name']}, {rupees(t['totalPaise'])}",
            f"Purchase of {len(b['lines'])} item{'s' if len(b['lines']) != 1 else ''}; input tax {rupees(tax)}. "
            + (f"TDS under {b['tds']['section']} of {rupees(b['tds']['amountPaise'])} to be deducted on payment." if b.get("tds") else "No TDS applies."),
            [{"label": "Bill total", "ref": {"kind": "document", "id": b["docId"], "region": "totals.total"}}, {"label": "Supplier GSTIN", "ref": {"kind": "document", "id": b["docId"], "region": "gstin"}}],
            {"billId": b["id"]},
            at(as_of, 9, 6 + i * 9),
        )
    q = next(x for x in quotes if x["id"] == "quote-006")
    stage("quote-desk", "quote", f"Send quotation {q['number']} to Kale Constructions, {rupees(q['totals']['totalPaise'])}", "Armoured cable, MCCBs and changeover switches at a 3% project discount, valid 15 days. Note: this customer has invoices over 60 days overdue.", [{"label": "Customer ageing", "ref": {"kind": "party", "id": "C13"}}], {"quoteId": q["id"]}, at(as_of, 11, 41))
    stage("marketer", "campaign", "Launch the WhatsApp scheme to clear MCCBs and pedestal fans", "Broadcast to 420 dealer contacts from 10 November with a 6% scheme price. Budget ₹15,000.", [{"label": "Stock on hand", "ref": {"kind": "report", "id": "stock"}}], {"campaignId": "camp-05"}, at(as_of, 12, 40))
    staged.extend(social["staged"])
    po = purchase_orders[2]
    stage("storekeeper", "purchase_order", f"Send purchase order {po['number']} to Deccan Lighting Co, {rupees(po['totalPaise'])}", f"{len(po['lines'])} lighting SKUs below reorder point; lead time about a week.", [{"label": "Stock report", "ref": {"kind": "report", "id": "stock"}}], {"poId": po["id"]}, at(as_of, 10, 12))
    stage("tax-clerk", "share_file", "Share the October GSTR-1 file with Mehta & Associates", "Built from 100% of October sales invoices in the books. Your accountant can upload it to the GST portal's offline tool.", [{"label": "October GSTR-1 register", "ref": {"kind": "report", "id": "gst"}}], {"returnId": "gstr1-2026-10"}, at(as_of, 10, 44))

    return {
        "leads": leads,
        "quotes": quotes,
        "campaigns": campaigns,
        "festivalCalendar": calendar,
        "competitorPrices": competitor_prices,
        "posts": posts,
        "socialInbox": inbox,
        "channels": social["channels"],
        "brandVoice": social["brandVoice"],
        "calendars": social["calendars"],
        "media": social["media"],
        "stock": stock,
        "purchaseOrders": purchase_orders,
        "rfqs": rfqs,
        "compliance": compliance,
        "employees": employees,
        "agents": agents,
        "teamLog": log,
        "staged": staged,
    }

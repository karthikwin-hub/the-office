"""The Social Media Manager's records: channels, brand voice, media, calendars,
posts written for each channel with their results, and the inbox."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MEDIA_OUT = ROOT / "apps/web/public/samples"
WHATSAPP_MARKETING_PAISE = 78
NAMES = {"instagram": "Instagram", "facebook": "Facebook", "threads": "Threads", "linkedin": "LinkedIn", "x": "X", "whatsapp": "WhatsApp", "google": "Google Business Profile"}


def at(d: date, hh: int, mm: int) -> str:
    return datetime(d.year, d.month, d.day, hh, mm).isoformat() + "+05:30"


def text_hash(text: str) -> str:
    """FNV-1a over UTF-16 code units, the same as textHash in the engine."""
    h = 0x811C9DC5
    units = text.encode("utf-16-le")
    for i in range(0, len(units), 2):
        h ^= units[i] | (units[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def group(n: int) -> str:
    s = str(n)
    if len(s) <= 3:
        return s
    head, tail = s[:-3], s[-3:]
    parts = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return ",".join(parts) + "," + tail


def with_gst(s: dict) -> int:
    return int(s["pricePaise"] * (100 + s["gstRate"]) / 100 / 100 + 0.5) * 100


def price(s: dict) -> str:
    return "\u20b9" + group(with_gst(s) // 100)


CHANNELS = [
    {"id": "ch-instagram", "platform": "instagram", "handle": "@kaverielectricals", "mode": "connected", "status": "connected", "lastError": None, "connectedAt": "2026-10-01T11:00:00+05:30", "followers": 3420, "postingHours": {"from": "11:00", "to": "20:00"}},
    {"id": "ch-facebook", "platform": "facebook", "handle": "Kaveri Electricals", "mode": "connected", "status": "connected", "lastError": None, "connectedAt": "2026-10-01T11:00:00+05:30", "followers": 5180, "postingHours": {"from": "10:00", "to": "21:00"}},
    {"id": "ch-threads", "platform": "threads", "handle": "@kaverielectricals", "mode": "manual", "status": "manual", "lastError": None, "connectedAt": None, "followers": 610, "postingHours": {"from": "11:00", "to": "20:00"}},
    {"id": "ch-linkedin", "platform": "linkedin", "handle": "Anil Kaveri", "mode": "connected", "status": "connected", "lastError": None, "connectedAt": "2026-10-03T10:00:00+05:30", "followers": 1240, "postingHours": {"from": "09:00", "to": "12:00"}},
    {"id": "ch-x", "platform": "x", "handle": "@kaveri_elec", "mode": "connected", "status": "rate_limited", "lastError": "X answered 429: the free tier's daily posting limit was reached", "connectedAt": "2026-10-03T10:00:00+05:30", "followers": 380, "postingHours": {"from": "09:00", "to": "19:00"}},
    {"id": "ch-whatsapp", "platform": "whatsapp", "handle": "+91 20 2712 4480", "mode": "connected", "status": "connected", "lastError": None, "connectedAt": "2026-10-05T12:00:00+05:30", "followers": 420, "postingHours": {"from": "10:00", "to": "19:00"}},
    {"id": "ch-google", "platform": "google", "handle": "Kaveri Electricals, Bhosari", "mode": "manual", "status": "manual", "lastError": None, "connectedAt": None, "followers": None, "postingHours": {"from": "10:00", "to": "18:00"}},
]

VOICE = {
    "tone": "Plain, warm and practical, like the counter manager who knows every product. Speaks to electricians and contractors as peers.",
    "dos": ["Name the product and what it does for the buyer", "Say where and when stock is available", "Thank customers by name"],
    "donts": ["No claims we cannot prove", "No competitor names", "No prices without GST"],
    "samples": [
        "BLDC fans use about half the power of a regular ceiling fan. Dealers: ask us for the price list.",
        "Fresh stock of 2x2 LED panels at our Bhosari godown. Same-day dispatch inside PCMC.",
        "Thank you to the electricians who joined our RCCB safety session last month.",
    ],
    "languages": ["en", "mr"],
    "hashtags": ["#PuneElectricals", "#KaveriElectricals"],
    "emoji": "light",
    "pillars": [
        {"id": "products", "name": "Products in stock", "share": 40, "description": "What is on the shelf and who it suits"},
        {"id": "know-how", "name": "Know-how", "share": 30, "description": "Safety, wiring and energy tips"},
        {"id": "offers", "name": "Offers and events", "share": 20, "description": "Schemes, meets and festival timings"},
        {"id": "behind", "name": "Behind the counter", "share": 10, "description": "Team, deliveries and customers"},
    ],
    "signoff": "",
}

MEDIA = [
    ("media-01", "SKU-402", "BLDC ceiling fan 1200 mm", "A brown BLDC ceiling fan with three blades, boxed and unboxed on the counter"),
    ("media-02", "SKU-303", "LED panel 2x2 ft 36 W", "A stack of square LED panels in their cartons at the Bhosari godown"),
    ("media-03", "SKU-306", "LED downlight 12 W", "Round LED downlights lit in a false ceiling"),
    ("media-04", "SKU-404", "Pedestal fan 400 mm", "A white pedestal fan on display beside the billing counter"),
    ("media-05", "SKU-203", "RCCB 4 pole 63 A 30 mA", "An RCCB fitted in an open distribution board"),
    ("media-06", "SKU-308", "Solar inverter 3 kVA", ""),
]


def media_svg(title: str, n: int) -> str:
    hue = [28, 205, 48, 160, 8, 95][n % 6]
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
<defs><pattern id="g" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="hsl({hue} 30% 80%)" stroke-width="1"/></pattern></defs>
<rect width="1080" height="1080" fill="hsl({hue} 35% 94%)"/><rect width="1080" height="1080" fill="url(#g)"/>
<rect x="240" y="220" width="600" height="520" rx="8" fill="none" stroke="hsl({hue} 40% 35%)" stroke-width="6" stroke-dasharray="18 10"/>
<text x="540" y="500" text-anchor="middle" font-family="Georgia, serif" font-size="56" fill="hsl({hue} 40% 25%)">{title}</text>
<text x="540" y="860" text-anchor="middle" font-family="ui-monospace, monospace" font-size="28" letter-spacing="4" fill="hsl({hue} 30% 35%)">SAMPLE PRODUCT PHOTO</text>
</svg>"""


def variant(channel_id: str, text: str, status: str, *, media=None, link=None, metrics=None, published=None, url=None, external=None, approved=False, error=None):
    platform = next(c["platform"] for c in CHANNELS if c["id"] == channel_id)
    return {
        "channelId": channel_id,
        "platform": platform,
        "text": text,
        "mediaIds": media or [],
        "link": link,
        "status": status,
        "externalId": external,
        "url": url,
        "publishedAt": published,
        "error": error,
        "approvedHash": text_hash(text) if approved else None,
        "metrics": metrics,
    }


def m(views, likes, comments, saves, shares=0, clicks=0, enquiries=0):
    return {"views": views, "likes": likes, "comments": comments, "saves": saves, "shares": shares, "clicks": clicks, "enquiries": enquiries}


def fact(kind, fid, label, value, ref_kind, ref_id):
    return {"id": fid, "kind": kind, "label": label, "value": value, "ref": {"kind": ref_kind, "id": ref_id}}


def sku_facts(s: dict, on_hand: int | None = None) -> list[dict]:
    out = [
        fact("price", f"price:{s['id']}", f"{s['name']}, price before GST", "\u20b9" + group(s["pricePaise"] // 100), "sku", s["id"]),
        fact("price", f"mrp:{s['id']}", f"{s['name']}, price with {s['gstRate']}% GST", price(s), "sku", s["id"]),
        fact("spec", f"gst:{s['id']}", f"{s['name']}, GST rate", f"{s['gstRate']}%", "sku", s["id"]),
    ]
    return out


def build_social(sku, party, invoices, leads, quotes, as_of: date) -> dict:
    MEDIA_OUT.mkdir(parents=True, exist_ok=True)
    media = []
    for i, (mid, sid, title, alt) in enumerate(MEDIA):
        (MEDIA_OUT / f"{mid}.svg").write_text(media_svg(title, i))
        media.append({"id": mid, "url": f"/samples/{mid}.svg", "kind": "image", "alt": alt, "skuId": sid, "rights": "own", "width": 1080, "height": 1080})

    d = lambda days: as_of + timedelta(days=days)  # noqa: E731
    bldc, panel, down, pedestal, rccb, inverter = (sku[x] for x in ("SKU-402", "SKU-303", "SKU-306", "SKU-404", "SKU-203", "SKU-308"))
    site = "https://kaverielectricals.in"
    utm = lambda path, platform, pid: f"{site}{path}?utm_source={platform}&utm_medium=social&utm_campaign={pid}"  # noqa: E731

    posts = [
        {
            "id": "post-01", "topic": "BLDC fans halve the power bill", "pillar": "products", "calendarId": "cal-2026-10", "campaignId": None, "status": "published", "at": at(d(-6), 18, 30), "skuIds": ["SKU-402"],
            "facts": sku_facts(bldc),
            "variants": [
                variant("ch-instagram", f"BLDC fans use about half the power of a regular ceiling fan. The {bldc['name']} is {price(bldc)} with GST at our Bhosari counter.\n\nLink in bio.\n\n#PuneElectricals #KaveriElectricals", "published", media=["media-01"], metrics=m(4820, 212, 18, 41, 23, 0, 6), published=at(d(-6), 18, 30), url="https://www.instagram.com/p/C7kav01/", external="17890001", approved=True),
                variant("ch-facebook", f"BLDC fans use about half the power of a regular ceiling fan. The {bldc['name']} is {price(bldc)} with GST at our Bhosari counter. Dealers, ask us for the price list.\n\n{utm('/fans', 'facebook', 'post-01')}\n\n#PuneElectricals", "published", media=["media-01"], link=utm("/fans", "facebook", "post-01"), metrics=m(3110, 96, 11, 0, 14, 72, 3), published=at(d(-6), 18, 31), url="https://www.facebook.com/kaverielectricals/posts/1001", external="1001", approved=True),
                variant("ch-threads", f"BLDC fans use about half the power of a regular ceiling fan. {bldc['name']}, {price(bldc)} with GST, in stock at Bhosari. #PuneElectricals", "published", metrics=m(640, 31, 4, 0, 2), published=at(d(-6), 19, 5), url="https://www.threads.net/@kaverielectricals/post/C7kth01", approved=True),
            ],
        },
        {
            "id": "post-02", "topic": "LED panels back in stock", "pillar": "products", "calendarId": "cal-2026-10", "campaignId": "camp-04", "status": "published", "at": at(d(-4), 11, 0), "skuIds": ["SKU-303"],
            "facts": sku_facts(panel),
            "variants": [
                variant("ch-google", "Fresh stock of 2x2 LED panels at our Bhosari godown. Same-day dispatch inside PCMC.", "published", media=["media-02"], metrics=m(1310, 0, 0, 0, 0, 58, 4), published=at(d(-4), 11, 0), url="https://g.page/kaveri-electricals/update/2", approved=True),
                variant("ch-facebook", f"Fresh stock of 2x2 LED panels at our Bhosari godown: the {panel['name']} at {price(panel)} with GST. Same-day dispatch inside PCMC.\n\n#PuneElectricals", "published", media=["media-02"], metrics=m(1980, 54, 6, 0, 5, 31, 2), published=at(d(-4), 11, 2), url="https://www.facebook.com/kaverielectricals/posts/1002", external="1002", approved=True),
            ],
        },
        {
            "id": "post-03", "topic": "Thank you, electricians", "pillar": "behind", "calendarId": "cal-2026-10", "campaignId": None, "status": "published", "at": at(d(-3), 19, 15), "skuIds": ["SKU-203"],
            "facts": [],
            "variants": [
                variant("ch-facebook", "Thank you to the electricians who joined our RCCB safety session last month. The next one is at the electricians' meet in Bhosari.", "published", media=["media-05"], metrics=m(2240, 133, 9, 4, 11), published=at(d(-3), 19, 15), url="https://www.facebook.com/kaverielectricals/posts/1003", external="1003", approved=True),
                variant("ch-instagram", "Thank you to the electricians who joined our RCCB safety session last month. See you at the next one.\n\n#PuneElectricals #KaveriElectricals", "published", media=["media-05"], metrics=m(2960, 241, 22, 37, 19, 0, 1), published=at(d(-3), 19, 16), url="https://www.instagram.com/p/C7kav03/", external="17890003", approved=True),
                variant("ch-linkedin", "Thank you to the electricians who joined our RCCB safety session last month. Safer wiring starts with the people who do it every day.", "published", metrics=m(1420, 58, 7, 0, 6), published=at(d(-3), 19, 20), url="https://www.linkedin.com/feed/update/urn:li:share:7001", external="urn:li:share:7001", approved=True),
            ],
        },
        {
            "id": "post-04", "topic": "Solar inverters for rooftop partners", "pillar": "products", "calendarId": "cal-2026-10", "campaignId": "camp-02", "status": "published", "at": at(d(-2), 10, 0), "skuIds": ["SKU-308"],
            "facts": sku_facts(inverter),
            "variants": [
                variant("ch-linkedin", "Kaveri Electricals now supplies 3 kVA solar inverters and 540 Wp modules for rooftop EPC partners across Maharashtra. Ask us for project pricing.", "published", media=["media-06"], metrics=m(1870, 64, 5, 0, 9, 41, 2), published=at(d(-2), 10, 0), url="https://www.linkedin.com/feed/update/urn:li:share:7002", external="urn:li:share:7002", approved=True),
                variant("ch-x", "3 kVA solar inverters and 540 Wp modules now in stock for rooftop EPC partners across Maharashtra. #PuneElectricals", "published", metrics=m(510, 9, 1, 0, 3, 6), published=at(d(-2), 10, 1), url="https://x.com/kaveri_elec/status/18000004", external="18000004", approved=True),
            ],
        },
        {
            "id": "post-05", "topic": "Wedding-season lighting", "pillar": "offers", "calendarId": "cal-2026-11", "campaignId": None, "status": "scheduled", "at": at(d(1), 18, 30), "skuIds": ["SKU-306", "SKU-302", "SKU-401"],
            "facts": sku_facts(down),
            "variants": [
                variant("ch-instagram", f"Wedding season is coming. Downlights, battens and fans for the whole house, from one counter. {down['name']} from {price(down)} with GST.\n\nLink in bio.\n\n#PuneElectricals #KaveriElectricals", "scheduled", media=["media-03"], approved=True),
                variant("ch-facebook", f"Wedding season is coming. Downlights, battens and fans for the whole house, from one counter. {down['name']} from {price(down)} with GST.\n\n#PuneElectricals", "scheduled", media=["media-03"], approved=True),
                variant("ch-threads", "Wedding season is coming. Downlights, battens and fans for the whole house, from one counter at Bhosari. #PuneElectricals", "scheduled", approved=True, error="Post by hand from the publishing pack"),
                variant("ch-whatsapp", f"Wedding season is coming. Downlights, battens and fans for the whole house, from one counter. {down['name']} from {price(down)} with GST. Reply to this message to reserve.", "draft", approved=True),
            ],
        },
        {
            "id": "post-06", "topic": "Sunday pickups", "pillar": "behind", "calendarId": "cal-2026-11", "campaignId": None, "status": "scheduled", "at": at(d(2), 11, 0), "skuIds": [],
            "facts": [],
            "variants": [
                variant("ch-google", "Open this Sunday, 10 am to 2 pm, for contractor pickups.", "scheduled", approved=True),
                variant("ch-facebook", "Open this Sunday, 10 am to 2 pm, for contractor pickups at Bhosari. Call ahead and we will have your order packed.", "scheduled", approved=True),
            ],
        },
        {
            "id": "post-07", "topic": "Pedestal fans while stock lasts", "pillar": "offers", "calendarId": "cal-2026-11", "campaignId": "camp-05", "status": "draft", "at": at(d(5), 18, 30), "skuIds": ["SKU-404"],
            "facts": sku_facts(pedestal),
            "variants": [
                {**variant("ch-instagram", f"Pedestal fans at a year-end price while stock lasts: the {pedestal['name']} is {price(pedestal)} with GST. Message us for dealer rates.\n\nLink in bio.\n\n#PuneElectricals #KaveriElectricals", "draft", media=["media-04"]), "approvedHash": text_hash("Pedestal fans at a year-end price while stock lasts. Message us for dealer rates.")},
                variant("ch-facebook", f"Pedestal fans at a year-end price while stock lasts: the {pedestal['name']} is {price(pedestal)} with GST. Message us for dealer rates.\n\n#PuneElectricals", "draft", media=["media-04"], approved=True),
                variant("ch-whatsapp", f"Pedestal fans at a year-end price while stock lasts: the {pedestal['name']} is {price(pedestal)} with GST. Reply to this message for dealer rates.", "draft", approved=True),
            ],
        },
        {
            "id": "post-08", "topic": "Pune electricians' meet", "pillar": "offers", "calendarId": "cal-2026-11", "campaignId": "camp-03", "status": "draft", "at": at(d(7), 19, 0), "skuIds": ["SKU-203", "SKU-205"],
            "facts": [fact("date", "campaign:camp-03:start", "Pune electricians' meet, Bhosari starts", "2026-11-22", "campaign", "camp-03")],
            "variants": [
                variant("ch-facebook", "Join us for the Pune electricians' meet at Bhosari on 22 November. Lunch, product demos and an RCCB testing session.\n\n#PuneElectricals", "draft", media=["media-05"]),
                variant("ch-linkedin", "Kaveri Electricals is hosting the Pune electricians' meet at Bhosari on 22 November: product demos from our switchgear partners and an RCCB testing session. Contractors and apprentices welcome.", "draft"),
                variant("ch-instagram", "Pune electricians' meet, Bhosari, 22 November. Lunch, demos and RCCB testing. Bring your team.\n\n#PuneElectricals #KaveriElectricals", "draft", media=["media-05"]),
            ],
        },
        {
            "id": "post-09", "topic": "LED downlights for new homes", "pillar": "products", "calendarId": None, "campaignId": None, "status": "draft", "at": at(d(9), 18, 0), "skuIds": ["SKU-306"],
            "facts": sku_facts(down),
            "variants": [
                variant("ch-instagram", "The cheapest LED downlights in Pune: 12 W for just \u20b9299. Better than any online seller.\n\nLink in bio.\n\n#PuneElectricals", "draft", media=["media-03"]),
                variant("ch-x", "The cheapest LED downlights in Pune: 12 W for just \u20b9299. Better than any online seller. #PuneElectricals", "draft"),
            ],
        },
    ]

    def slot(day: date, pillar: str, topic: str, channels: list[str], post_id: str | None):
        return {"date": day.isoformat(), "pillarId": pillar, "topic": topic, "channelIds": channels, "postId": post_id}

    social_ch = ["ch-instagram", "ch-facebook", "ch-threads", "ch-x"]
    calendars = [
        {"id": "cal-2026-10", "month": "2026-10", "status": "approved", "createdAt": "2026-09-25T09:00:00+05:30", "approvedAt": "2026-09-26T10:12:00+05:30", "approvedBy": "Anil Kaveri", "slots": [
            slot(d(-6), "products", "BLDC fans halve the power bill", social_ch, "post-01"),
            slot(d(-4), "products", "LED panels back in stock", ["ch-google", "ch-facebook"], "post-02"),
            slot(d(-3), "behind", "Thank you, electricians", ["ch-facebook", "ch-instagram", "ch-linkedin"], "post-03"),
            slot(d(-2), "products", "Solar inverters for rooftop partners", ["ch-linkedin", "ch-x"], "post-04"),
        ]},
        {"id": "cal-2026-11", "month": "2026-11", "status": "approved", "createdAt": "2026-10-25T09:00:00+05:30", "approvedAt": "2026-10-27T18:40:00+05:30", "approvedBy": "Anil Kaveri", "slots": [
            slot(d(1), "offers", "Wedding-season lighting", ["ch-instagram", "ch-facebook", "ch-threads", "ch-whatsapp"], "post-05"),
            slot(d(2), "behind", "Sunday pickups", ["ch-google", "ch-facebook"], "post-06"),
            slot(d(5), "offers", "Pedestal fans while stock lasts", ["ch-instagram", "ch-facebook", "ch-whatsapp"], "post-07"),
            slot(d(7), "offers", "Pune electricians' meet", ["ch-facebook", "ch-linkedin", "ch-instagram"], "post-08"),
            slot(d(12), "know-how", "Earthing checks every home should have", ["ch-instagram", "ch-facebook", "ch-linkedin", "ch-threads", "ch-x"], None),
            slot(d(14), "products", "RCCB 4 pole 63 A 30 mA in stock", social_ch, None),
            slot(d(16), "know-how", "What an RCCB protects you from", ["ch-instagram", "ch-facebook", "ch-linkedin"], None),
            slot(d(19), "offers", "Tulsi Vivah, start of wedding season timings and offers", ["ch-instagram", "ch-facebook", "ch-whatsapp", "ch-threads"], None),
            slot(d(21), "products", "LED downlight 12 W in stock", social_ch, None),
            slot(d(23), "know-how", "LED lighting that cuts the power bill", ["ch-instagram", "ch-facebook", "ch-linkedin", "ch-x"], None),
            slot(d(26), "products", "Distribution board 8 way DP in stock", social_ch, None),
        ]},
    ]
    dec_days = [date(2026, 12, x) for x in (2, 4, 7, 9, 11, 14, 16, 18, 21, 23, 25, 28, 30)]
    dec_plan = [
        ("products", "Pedestal fan 400 mm in stock"), ("know-how", "How to pick the right MCB rating for a room"), ("products", "Solar inverter 3 kVA in stock"),
        ("behind", "New stock in at the godown"), ("know-how", "Why ISI-marked wire is worth it"), ("products", "BLDC ceiling fan 1200 mm in stock"),
        ("offers", "Solar rooftop kits for contractors"), ("know-how", "Sizing wire for an AC point"), ("products", "LED panel 2x2 ft 36 W in stock"),
        ("offers", "Christmas and year-end closing timings and offers"), ("know-how", "Earthing checks every home should have"), ("products", "Ceiling fan 1200 mm in stock"),
        ("behind", "Meet the counter team"),
    ]
    pillar_channels = {"products": social_ch, "know-how": ["ch-instagram", "ch-facebook", "ch-linkedin", "ch-threads", "ch-x"], "offers": ["ch-instagram", "ch-facebook", "ch-whatsapp", "ch-x", "ch-threads"], "behind": ["ch-instagram", "ch-facebook", "ch-linkedin"]}
    calendars.append({"id": "cal-2026-12", "month": "2026-12", "status": "draft", "createdAt": at(as_of, 17, 20), "approvedAt": None, "approvedBy": None, "slots": [slot(day, p, t, pillar_channels[p], None) for day, (p, t) in zip(dec_days, dec_plan)]})

    # A customer who first wrote on Instagram, was quoted, and has been invoiced since.
    first_touch = lambda q: (date.fromisoformat(q["date"]) - timedelta(days=40)).isoformat()  # noqa: E731
    accepted = [q for q in quotes if q["status"] == "accepted" and q["partyId"] and any(i["partyId"] == q["partyId"] and i["date"] >= first_touch(q) for i in invoices)]
    if accepted:
        q = accepted[0]
        p = party[q["partyId"]]
        lead_id = f"lead-{len(leads) + 1:03d}"
        leads.append({"id": lead_id, "name": p["name"], "city": p.get("city", ""), "source": "Instagram", "stage": "won", "valuePaise": q["totals"]["totalPaise"], "need": "Asked about RCCBs and distribution boards under the monsoon safety reel", "createdOn": first_touch(q), "lastTouchOn": q["date"], "nextStep": "Hand over to dispatch"})
        q["leadId"] = lead_id

    def msg(mid, channel, kind, author, when, rating, text, sentiment, intent, reply, status="open", post=None, lead=None, reply_by=None):
        platform = {"ch-google": "Google reviews"}.get(channel) or NAMES[next(c["platform"] for c in CHANNELS if c["id"] == channel)]
        return {"id": mid, "platform": platform, "channelId": channel, "kind": kind, "author": author, "at": when, "rating": rating, "text": text, "sentiment": sentiment, "intent": intent, "draftReply": reply, "status": status, "postId": post, "threadId": None, "externalId": None, "leadId": lead, "replyBy": reply_by}

    inbox = [
        msg("msg-01", "ch-google", "review", "Prashant K.", at(as_of, 9, 12), 2, "Waited 40 minutes at the counter for a simple MCB order. Staff were polite but slow.", "negative", "complaint", "Prashant, thank you for telling us. Forty minutes is too long for a counter order. We have added a second billing counter from this week; please ask for Leena next time and we will have you out in ten minutes."),
        msg("msg-02", "ch-instagram", "comment", "@sparkline_electricals", at(as_of, 10, 40), None, "Do you have BLDC fans in brown? Need 24 pieces for a site in Wakad.", "neutral", "enquiry", "Thanks for asking. Our sales team will send you the details and a quotation shortly.", post="post-01", lead="lead-msg-02"),
        msg("msg-03", "ch-google", "review", "Sneha Joshi", at(as_of - timedelta(days=1), 17, 5), 5, "Genuine products and proper GST bills every time. Delivery to Hinjewadi was next day.", "positive", "praise", "Thank you, Sneha. We are glad the Hinjewadi delivery reached on time."),
        msg("msg-04", "ch-facebook", "comment", "Ramdas Pawar", at(as_of - timedelta(days=1), 20, 22), None, "Is the electricians' meet open to apprentices?", "neutral", "question", "Yes, apprentices are welcome with their supervisor. Please register at the counter or reply here with names.", status="replied", post="post-03"),
        msg("msg-05", "ch-google", "review", "Vikram D.", at(as_of - timedelta(days=2), 13, 48), 4, "Good range, slightly higher price than online for LED panels.", "neutral", "question", "Thank you, Vikram. For bulk orders please ask at the counter for our project rate."),
        msg("msg-06", "ch-instagram", "comment", "@homeworks.pune", at(as_of - timedelta(days=3), 16, 2), None, "Loved the RCCB safety reel. Can you do one on earthing?", "positive", "praise", "Great idea. An earthing explainer is planned for next week.", status="replied", post="post-03"),
        msg("msg-07", "ch-instagram", "comment", "@nikhil.builds", at(as_of, 8, 55), None, "What is the rate for 10 of these BLDC fans? Flat in Baner.", "neutral", "enquiry", "Thanks for asking, Nikhil. Our sales team will send you the details and a quotation shortly.", post="post-01", lead="lead-msg-07"),
        msg("msg-08", "ch-whatsapp", "dm", "Santosh Electricals", at(as_of, 9, 58), None, "Namaskar. MCB 32 A double pole, 50 pcs available? Delivery to Chakan.", "neutral", "enquiry", "Thanks for asking, Santosh. Our sales team will send you the details and a quotation shortly.", lead="lead-msg-08", reply_by=(datetime(as_of.year, as_of.month, as_of.day, 9, 58) + timedelta(hours=24) - timedelta(hours=5, minutes=30)).isoformat() + "Z"),
        msg("msg-09", "ch-facebook", "comment", "Meera Kulkarni", at(as_of, 7, 40), None, "Very useful session, thank you Kaveri team!", "positive", "praise", "Thank you, Meera. We are glad it helped, and we look forward to seeing you again at Kaveri Electricals.", post="post-03"),
        msg("msg-10", "ch-instagram", "comment", "@growfast.media", at(as_of, 6, 12), None, "Get 10k real followers cheap, click here bit.ly/xx", "neutral", "spam", "", post="post-01"),
        msg("msg-11", "ch-x", "mention", "@ajay_wires", at(as_of - timedelta(days=1), 15, 30), None, "@kaveri_elec do you stock 4 sq mm FR wire?", "neutral", "enquiry", "Thanks, Ajay. Our sales team will send you the details shortly.", post="post-04", lead="lead-msg-11"),
        msg("msg-12", "ch-linkedin", "comment", "Rohan Deshpande", at(as_of - timedelta(days=1), 11, 5), None, "Interested in the 3 kVA inverter for 12 rooftop sites. Can you share project pricing?", "neutral", "enquiry", "Thanks for asking, Rohan. Our sales team will send you the details and a quotation shortly.", post="post-04", lead="lead-msg-12"),
    ]
    for x in inbox:
        if not x["leadId"]:
            continue
        day = x["at"][:10]
        leads.append({"id": x["leadId"], "name": x["author"], "city": "", "source": "WhatsApp" if x["channelId"] == "ch-whatsapp" else x["platform"], "stage": "new", "valuePaise": 0, "need": x["text"], "createdOn": day, "lastTouchOn": day, "nextStep": f"Reply on {x['platform']} with a quotation"})

    staged = []

    def stage(sid, kind, title, summary, evidence, payload, created):
        staged.append({"id": sid, "agentId": "social-media-manager", "kind": kind, "createdAt": created, "title": title, "summary": summary, "evidence": evidence, "payload": payload, "status": "pending"})

    for x in inbox:
        if x["status"] != "open" or x["intent"] == "spam":
            continue
        what = f"{x['rating']}-star review" if x["kind"] == "review" else {"dm": "message", "mention": "mention"}.get(x["kind"], "comment")
        ev = [{"label": "The message", "ref": {"kind": "social", "id": x["id"]}}] + ([{"label": "The lead", "ref": {"kind": "lead", "id": x["leadId"]}}] if x["leadId"] else [])
        summary = f"\"{x['text']}\"" + (" Passed to the Sales Rep as a lead." if x["leadId"] else "") + (" WhatsApp allows a free reply until tomorrow, 9:58 am." if x["replyBy"] else "")
        stage(f"chg-reply-{x['id']}", "social_reply", f"Reply to {x['author']}'s {what} on {x['platform']}", summary, ev, {"messageId": x["id"], "reply": x["draftReply"]}, x["at"])

    def post_card(p, note):
        chans = [NAMES[v["platform"]] for v in p["variants"]]
        listed = ", ".join(chans[:-1]) + f" and {chans[-1]}" if len(chans) > 1 else chans[0]
        day = date.fromisoformat(p["at"][:10])
        ev = [{"label": f"{sku[s]['name']}: price and stock", "ref": {"kind": "figure", "id": f"sku:{s}"}} for s in p["skuIds"]]
        ev += [{"label": "The campaign", "ref": {"kind": "campaign", "id": p["campaignId"]}}] if p["campaignId"] else []
        ev += [{"label": "The post", "ref": {"kind": "post", "id": p["id"]}}]
        stage(f"chg-post-{p['id']}", "post", f"Publish \"{p['topic']}\" on {listed}, {day.day} {day.strftime('%B %Y')}", note, ev, {"postId": p["id"]}, at(as_of, 11, 25))

    by_id = {p["id"]: p for p in posts}
    post_card(by_id["post-07"], "From the calendar you approved. Held back: the Instagram version changed after approval.")
    post_card(by_id["post-08"], "From the calendar you approved.")
    post_card(by_id["post-09"], "A new post, not in the calendar.")
    p5 = by_id["post-05"]
    audience = next(c["followers"] for c in CHANNELS if c["id"] == "ch-whatsapp")
    cost = audience * WHATSAPP_MARKETING_PAISE
    stage("chg-bc-post-05", "broadcast", f"Send \"Wedding-season lighting\" on WhatsApp to {audience} customers, about \u20b9{group(round(cost / 100))}", f"A broadcast is a paid marketing message to customers who agreed to hear from you, at roughly \u20b9{WHATSAPP_MARKETING_PAISE / 100:.2f} each in India; check Meta's current rate. It always asks.", [{"label": "The post", "ref": {"kind": "post", "id": "post-05"}}], {"postId": "post-05", "channelId": "ch-whatsapp", "audience": audience, "costPaise": cost, "text": p5["variants"][3]["text"]}, at(as_of - timedelta(days=1), 17, 2))
    dec = calendars[-1]
    dec_channels = len({c for s in dec["slots"] for c in s["channelIds"]})
    stage("chg-cal-2026-12", "calendar", f"Approve the December 2026 calendar: {len(dec['slots'])} posts across {dec_channels} channels", "5 products in stock, 4 know-how, 2 offers and events, 2 behind the counter. Each post is drafted when you approve and must pass every check again at its time.", [{"label": "The calendar", "ref": {"kind": "calendar", "id": "cal-2026-12"}}], {"calendarId": "cal-2026-12", "postIds": []}, at(as_of, 17, 20))

    return {"posts": posts, "socialInbox": inbox, "channels": CHANNELS, "brandVoice": VOICE, "calendars": calendars, "media": media, "staged": staged}

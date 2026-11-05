# Synthetic business

Generates Kaveri Electricals, the fictional Pune distributor behind every mockup screen, from one seed (`SEED = 2611`).

```bash
uv venv .venv && uv pip install -p .venv reportlab
.venv/bin/python tools/synthetic/generate.py
```

Writes `packages/fixtures/data/office.json` and one PDF per sales invoice and purchase bill in `apps/web/public/docs/`. Each document records the page region of every printed figure so the source viewer can highlight it.

All amounts are integer paise with half-up rounding (`money.py`), mirrored exactly by `packages/engine/src/money.ts`; the engine's tests recompute every printed total.

## Deliberate problems for the agents to find

| Where | What | Who should catch it |
|---|---|---|
| October GSTR-1 draft from the accountant | One sales invoice left out | The Auditor |
| October GSTR-3B draft | ITC of Rs 38,200 claimed on Deccan Lighting bill DLC/2610/488, which is missing from GSTR-2B | The Auditor |
| 26Q for July to September (filed) | Mehta & Associates fees deducted at 2% instead of 10% under 194J | The Auditor |
| 26Q for July to September (filed) | August rent deduction under 194I left out | The Auditor |
| Form 26AS | One 194Q deduction by Sahyog Infratech not reported | The Auditor |
| Customer payments | Wagh Power Solutions and Kale Constructions pay very late | The Credit Controller |
| Stock | Five slow-moving SKUs with high stock | The Storekeeper and The Marketer |

Following `.cursor/skills/pdf/SKILL.md`: reportlab's built-in fonts have no rupee glyph, so documents print "Rs." as many real invoices do.

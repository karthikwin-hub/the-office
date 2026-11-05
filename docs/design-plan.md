# The Office: design plan

Written following `.cursor/skills/frontend-design/SKILL.md`: brief, token system, layouts, then a review against the brief before any UI code.

## Brief

- **Subject:** the back office of an Indian trading business (our sample is Kaveri Electricals, Pune), run by a team of software agents.
- **Audience:** the owner first; their chartered accountant as a second, read-mostly user.
- **Primary job:** let the owner check the business and approve what the team proposes, with proof for every figure.
- **Grounding in the subject's world:** the duplicate invoice book with its blue carbon copy, the rubber stamp ("Paid", "Overdue"), the ledger's ruled columns, and an architect's floor plan of the office itself.

## Tokens

### Colour

| Name | Hex | Role |
|---|---|---|
| Duplicate paper | `#F3F5F7` | Page background. Cool grey-white, deliberately not cream |
| Carbon blue | `#27408B` | Primary ink: links, selection, focus, the floor plan's active rooms |
| Graphite | `#2A2D31` | Body text and figures |
| Plan line | `#B4BCC6` | Floor-plan walls, table rules, input borders |
| Stamp red | `#B42318` | Overdue and mismatch only |
| Cleared green | `#2F6B3F` | Paid and matched only |

Derived tints (for row highlights and the source-document highlight box) are mixed from these six, never new hues.

### Type

- One family: **Atkinson Hyperlegible Next** (SIL OFL), weights 400, 500, 700. It was designed by the Braille Institute to keep confusable glyphs apart (0/O, 1/l/I, 5/S, 8/B), which is the whole job when checking amounts against paper.
- Every figure uses `font-variant-numeric: tabular-nums` (the font ships `tnum`), right-aligned in columns.
- Indian digit grouping everywhere (`1,84,000`); prose uses lakh and crore (`₹18.6 lakh`).
- Modular scale 1.25 on a 16px base: 12.8 / 16 / 20 / 25 / 31.25 / 39. Body line-height 1.5; headings 1.2. Measure capped at 72ch.
- Sentence case throughout. No all-caps labels, no tracked-out eyebrows.

### Space and shape

- 4px base grid: 4, 8, 12, 16, 24, 32, 48, 64.
- Shape follows hierarchy, not one radius for everything: floor-plan walls are square drawn lines; controls get a 3px radius; floating panels (Office Manager, source viewer) get 6px and the only shadow in the system.
- Status is shown with stamps: an outlined rectangle in stamp red or cleared green with sentence-case text. Only four stamps exist: Overdue, Mismatch, Paid, Matched.

## Layouts

### The Floor (the one bold element)

```
+------------------------------------------------------------------+
| Kaveri Electricals   Floor  Boardroom  Your desk 7   As of 4 Nov |
+---------------------------------------------+--------------------+
|  Accounts wing                              | Team log           |
|  +-------------+-------------+              | 10:42 Accountant   |
|  | Accountant  | Tax clerk   |              |  read INV-2231     |
|  | 12 read     | GSTR-1 ready|              | 10:44 Credit       |
|  +----]  [-----+----]  [-----+              |  controller drafted|
|  ========== corridor ==================     |  a reminder        |
|  +----]  [-----+----]  [-----+ - - - - +    |                    |
|  | Credit      | Auditor     : Sales     :  |                    |
|  | controller  | 2 mismatches: not hired :  |                    |
|  +-------------+-------------+ - - - - +    |                    |
+---------------------------------------------+--------------------+
```

Wing names are lettered into the drawing itself, in sentence case at the plan's line weight, rather than set as UI eyebrows. Rooms are left-aligned text inside drawn walls. A door gap opens on the corridor side; a room waiting on you has a small carbon-blue count at its door. Unhired rooms are dashed outlines. On mobile the plan becomes a vertical corridor with rooms stacked on both sides, and the team log moves below.

### The Boardroom

```
+------------------------------------------------------------------+
| Accounts  Sales  Marketing  Social  Operations  People           |
+------------------------------------------------------------------+
| Covering note                                                    |
| Sales in October were ₹42.1 lakh across 38 SKUs. ₹18.6 lakh is   |
| due from 14 customers, ₹6.2 lakh of it over 60 days.             |
+----------------+-------------------------------------------------+
| Sales by SKU   |  SKU        HSN    Qty    Taxable   Margin  ... |
| Ageing         |  ...                                            |
| GST            |                                                 |
| TDS            |                                                 |
| Cash           |                                                 |
+----------------+-------------------------------------------------+
```

Every figure in the covering note and every table cell is a link that opens the source viewer.

### Your desk

A single column of approval items, each written as the exact action ("Send reminder to Sharma Traders for INV-2231, ₹1,84,000, 34 days overdue"), the evidence beneath it, and Approve / Edit / Reject. Grouped by agent, newest first.

## Principles

1. The floor plan is the one memorable thing. Everything else is a quiet, well-ruled ledger.
2. Red and green carry meaning and nothing else.
3. Every figure is a link to its proof.
4. Copy names the action: "Send reminder" produces "Reminder sent".
5. Quality floor, never announced: keyboard focus visible, reduced motion respected, AA contrast, usable on a phone.
6. One orchestrated motion: a document travelling down the corridor to its room. Nothing else animates on its own.

## Review against the brief

Working through "dashboard for a small-business accounting product" from scratch, my defaults would have been: left icon sidebar, a row of KPI cards (big number, small label, sparkline), rounded cards with soft shadows, coloured status pills, Inter. Each was checked and revised:

- **KPI card row: replaced** with a covering note, the way an accountant sends figures to an owner: a short written paragraph whose numbers are links. It is more legible to a non-finance owner and is specific to this relationship.
- **Icon sidebar: replaced** with three spaces named in the top bar (Floor, Boardroom, Your desk). The office metaphor is the navigation; a sidebar would bury it.
- **Rounded card grid: removed.** Content sits on the page separated by plan-line rules and whitespace; only floating panels are raised.
- **Status pills: replaced** with four stamps tied to real paperwork vocabulary.
- **Typeface: changed** from a default grotesque to Atkinson Hyperlegible Next for the 0/O and 1/l reason above.
- **Checked against the skill's list of generated-design tells:** no cream and terracotta, no near-black with an acid accent, no broadsheet hairline columns, no all-caps eyebrows, no middle-dot meta strings, no monospace data labels, no arrows appended to buttons, no per-section fade-up entrances.

## Mockup review rounds

Screenshots come from `pnpm screenshots app --dir apps/web/dist` (every screen at 1440 px and 390 px) and `pnpm screenshots stories --dir packages/ui/storybook-static`. They land in `screenshots/latest/`, which is git-ignored.

**Round 1 (UI kit in Storybook)**

- Door leaves swung into the rooms and cut through the room text. Doors now swing out into the corridor, as fire doors are drawn, and the waiting count sits beside the door instead of in the doorway.
- On the phone plan, counts from facing doors collided in the corridor. Left-side doors now sit at the bottom of their rooms and right-side doors at the top, with smaller leaves.
- Room counts read "1 returns prepared"; labels are now singular for one.
- Numeric column headings were left-aligned over right-aligned figures (a specificity clash between `.ledger th` and `th.num`).
- The hire button read "Hire the payroll Clerk".

**Round 2 (every screen on sample data)**

- The reception's notes ran into the entrance on narrower screens; capped at four lines.
- Observable Plot cannot resolve CSS variables, so the sales chart showed a warning; charts now take literal ink colours that mirror the tokens.
- Quantities showed GST unit codes ("571 rol", "pac"); they are spelled out as "571 rolls", "packs".
- 15 reminders from one agent made the desk a long scroll; groups of the same kind can be approved together ("Send reminder for all 15").
- On the phone the desk filters took four rows; they scroll sideways.
- Text built from short names read badly ("What the social media did"); agent names in sentences use the full title.
- Social replies in an agent's room lacked the message being answered; it now shows, as on the desk.
- The accountant's preview said work was "waiting for you"; it now says the work is waiting for the owner, and the tab reads "Owner's desk".

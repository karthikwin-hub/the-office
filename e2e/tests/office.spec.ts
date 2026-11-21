import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { checkA11y } from "../support/axe";
import { nextTotp } from "../support/totp";
import { unzip } from "../support/zip";

// One owner's first day, in order: each step starts where the last one left the browser.
test.describe.configure({ mode: "serial" });

const run = Date.now().toString(36);
const owner = { name: "Anil Kumar", email: `anil-${run}@example.test`, password: `e2e-${run}-not-a-real-password` };
const business = "Lakeside Hardware";
const accountant = `meera-${run}@example.test`;
/** A synthetic invoice made by the sample business's generator (tools/synthetic), never a client's document. */
const SAMPLE_PDF = resolve(import.meta.dirname, "../../apps/web/public/docs/doc-p0001.pdf");

let context: BrowserContext;
let page: Page;
let key = "";
/** When the last authenticator code was used: the next one must come from a later 30 seconds. */
let lastCode = 0;
/** Uncaught errors in the page since the last step: any one fails that step. */
const pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ acceptDownloads: true });
  page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
});
test.afterEach(() => {
  expect(pageErrors.splice(0), "uncaught errors in the page").toEqual([]);
});
test.afterAll(async () => context.close());

/** Types a fresh authenticator code into the field labelled `label` and submits with `button`. */
async function enterCode(label: string | RegExp, button: string | RegExp) {
  const { code, at } = await nextTotp(key, lastCode);
  lastCode = at;
  await page.getByLabel(label).fill(code);
  await page.getByRole("button", { name: button }).click();
}

test("sign up", async () => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
  await checkA11y(page, "sign in");
  await page.getByRole("button", { name: "Make an account" }).click();
  await checkA11y(page, "sign up");
  await page.getByLabel("Your name").fill(owner.name);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("checkbox", { name: /I accept the terms of service/ }).check();
  await page.getByRole("button", { name: "Make the account" }).click();
  await expect(page.getByRole("heading", { name: "Open your office" })).toBeVisible();
});

test("open an office and turn on two-step sign-in", async () => {
  await checkA11y(page, "open an office");
  await page.getByLabel("Business name").fill(business);
  await page.getByRole("button", { name: "Open the office" }).click();
  await expect(page.getByRole("heading", { name: "Turn on two-step sign-in" })).toBeVisible();
  await checkA11y(page, "two-step sign-in: password");
  await page.getByLabel("Your password").fill(owner.password);
  await page.getByRole("button", { name: "Set up two-step sign-in" }).click();
  key = (await page.locator("form code").first().textContent())?.trim() ?? "";
  expect(key).toMatch(/^[A-Z2-7]{16,}=*$/);
  await expect(page.getByRole("list", { name: "Backup codes" }).getByRole("listitem")).toHaveCount(10);
  await checkA11y(page, "two-step sign-in: key and codes");
  await enterCode("3. The six-digit code the app shows now", "Turn on two-step sign-in");
  await expect(page.locator(".topbar-business")).toContainText(business);
});

test("the floor", async () => {
  await checkA11y(page, "floor");
});

test("the other main screens", async () => {
  for (const [link, screen] of [
    ["Boardroom", "boardroom"],
    ["Hiring hall", "hiring hall"],
    ["Routines", "routines"],
  ] as const) {
    await page.getByRole("banner").getByRole("link", { name: link }).click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await checkA11y(page, screen);
  }
  await page.goto("/audit");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await checkA11y(page, "audit");
  await page.goto("/");
});

test("upload an invoice, and approve what the Accountant prepared", async () => {
  await page.goto("/rooms/accountant");
  await expect(page.getByText("Drop bills or invoices here")).toBeVisible();
  await checkA11y(page, "accountant's room");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "choose files" }).click();
  await (await chooser).setFiles(SAMPLE_PDF);
  const intake = page.locator(".intake li").first();
  await expect(intake).toHaveClass(/intake-done/, { timeout: 30_000 });
  await intake.getByRole("link", { name: "On your desk" }).click();

  await expect(page).toHaveURL(/\/desk/);
  await checkA11y(page, "desk");
  // A new office has no GSTIN yet, so the Accountant takes the invoice as one it issued; it read it from the text layer alone.
  const card = page.getByRole("article", { name: /^Record sales invoice SCPL\/2604\/321/ });
  await card.getByRole("button", { name: "Record invoice" }).click();
  await expect(card).toBeHidden();
  await expect(page.getByRole("link", { name: "Your desk" })).not.toContainText("waiting");
});

test("find the customer that invoice brought in, under Customers and suppliers", async () => {
  await page.goto("/boardroom/accounts");
  await page.getByRole("navigation", { name: "Accounts reports" }).getByRole("link", { name: "Customers and suppliers" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Customers and suppliers" })).toBeVisible();
  const table = page.getByRole("table", { name: "Customers and suppliers" });
  await expect(table.getByRole("row")).toHaveCount(3); // the header, one customer, the totals
  await expect(table.getByRole("cell", { name: "Customer", exact: true })).toBeVisible();
  await checkA11y(page, "customers and suppliers");
  await page.getByLabel("Search customers and suppliers").fill("no such party");
  await expect(page.getByText("No customer or supplier matches.")).toBeVisible();
  await page.getByLabel("Search customers and suppliers").fill("");
  await table.getByRole("row").nth(1).getByRole("link").click();
  await expect(page).toHaveURL(/\/parties\/[^/]+$/);
  await expect(page.getByRole("link", { name: "Customers and suppliers" })).toBeVisible();
});

test("invite the accountant", async () => {
  await page.goto("/settings");
  await checkA11y(page, "settings");
  await page.getByLabel("Invite someone").fill(accountant);
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.getByLabel("Invitation link")).toHaveValue(/#/);
  await expect(page.getByText(accountant, { exact: true })).toBeVisible();
  await expect(page.getByText(`${owner.email} invited ${accountant} as accountant`)).toBeVisible();
});

test("export the office, and the archive opens", async () => {
  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Download everything" }).click();
  const zip = unzip(await readFile((await (await download).path())!));
  const names = [...zip.keys()];
  expect(names[0]).toBe("books.json");
  const saved = JSON.parse(zip.get("books.json")!.toString("utf8"));
  expect(saved.books.business.name).toBe(business);
  // The approved invoice is in the books, and the PDF it came from is in the archive byte for byte.
  expect(saved.books.invoices.map((i: { number: string }) => i.number)).toContain("SCPL/2604/321");
  const pdf = names.find((n) => n.startsWith("files/") && !n.endsWith(".txt"));
  expect(pdf, names.join(", ")).toBeTruthy();
  expect(zip.get(pdf!)!.equals(await readFile(SAMPLE_PDF))).toBe(true);
});

test("sign out, and back in with a code from the app", async () => {
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("Code from your app")).toBeVisible();
  await checkA11y(page, "two-step sign-in: code");
  await enterCode("Code from your app", /^(sign in|continue|verify)$/i);
  await expect(page.locator(".topbar-business")).toContainText(business);
});

import { ageingReport, OfficeService, salesReport, trace } from "@office/engine";
import { loadBooks } from "@office/fixtures";

/** Stories render real engine output over the sample books, never hand-written props. */
export const office = new OfficeService(loadBooks());
export const view = office.officeView();
export const desk = office.desk();
export const sales = salesReport(office.ledger);
export const ageing = ageingReport(office.ledger);
export const sampleTrace = trace(office.ledger, "ageing:party:C13");
export const byKind = (kind: string) => desk.items.find((i) => i.kind === kind)!;

/** A first-week office: only the Office Manager and the Accountant are on the team. */
export function newOffice() {
  const o = new OfficeService(loadBooks());
  for (const a of o.books.agents) if (!["office-manager", "accountant"].includes(a.agentId)) o.setHiring(a.agentId, { hired: false });
  return o.officeView();
}

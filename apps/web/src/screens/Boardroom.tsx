import { AGENT_BY_ID, AGENTS, TEAMS } from "@office/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { q } from "../api/queries";
import { AgeingView, CashView, GstView, SalesView, TdsView } from "../reports/accounts";
import { CalendarView, PostsView, SocialInboxView, SocialResultsView } from "../reports/social";
import { CampaignsView, ComplianceView, FestivalsView, OrdersView, PayrollView, PipelineView, PricesView, QuotesView, ReordersView, SlowStockView, StockView } from "../reports/teams";
import { Page, PageHead, theAgent } from "./common";

type Tab = { id: string; label: string; agent: string; render: () => { ready: boolean; error?: unknown; node: ReactNode } };

function useTabs(team: string): Tab[] {
  const [gstPeriod, setGstPeriod] = useState<string>();
  const [tdsQuarter, setTdsQuarter] = useState<string>();
  const sales = useQuery({ ...q.sales(), enabled: team === "accounts" });
  const ageing = useQuery({ ...q.ageing(), enabled: team === "accounts" });
  const gst = useQuery({ ...q.gst(gstPeriod), enabled: team === "accounts" });
  const tds = useQuery({ ...q.tds(tdsQuarter), enabled: team === "accounts" });
  const cash = useQuery({ ...q.cash(), enabled: team === "accounts" });
  const st = useQuery({ ...q.salesTeam(), enabled: team === "sales" });
  const mk = useQuery({ ...q.marketing(), enabled: team === "marketing" });
  const so = useQuery({ ...q.social(), enabled: team === "social" });
  const op = useQuery({ ...q.operations(), enabled: team === "operations" });
  const pe = useQuery({ ...q.people(), enabled: team === "people" });
  const r = <T,>(x: { data?: T; error: unknown }, f: (d: T) => ReactNode) => () => ({ ready: Boolean(x.data), error: x.error, node: x.data ? f(x.data) : null });

  switch (team) {
    case "accounts":
      return [
        { id: "sales", label: "Sales", agent: "accountant", render: r(sales, (d) => <SalesView report={d} />) },
        { id: "ageing", label: "Who owes you", agent: "credit-controller", render: r(ageing, (d) => <AgeingView report={d} />) },
        { id: "gst", label: "GST", agent: "tax-clerk", render: r(gst, (d) => <GstView report={d} onPeriod={setGstPeriod} />) },
        { id: "tds", label: "TDS", agent: "tax-clerk", render: r(tds, (d) => <TdsView report={d} onQuarter={setTdsQuarter} />) },
        { id: "cash", label: "Cash ahead", agent: "accountant", render: r(cash, (d) => <CashView report={d} />) },
      ];
    case "sales":
      return [
        { id: "pipeline", label: "Pipeline", agent: "sales-rep", render: r(st, (d) => <PipelineView report={d} />) },
        { id: "quotes", label: "Quotations", agent: "quote-desk", render: r(st, (d) => <QuotesView report={d} />) },
        { id: "reorders", label: "Reorders", agent: "account-manager", render: r(st, (d) => <ReordersView report={d} />) },
      ];
    case "marketing":
      return [
        { id: "campaigns", label: "Campaigns", agent: "marketer", render: r(mk, (d) => <CampaignsView report={d} compact />) },
        { id: "slow", label: "Slow stock", agent: "marketer", render: r(mk, (d) => <SlowStockView report={d} />) },
        { id: "prices", label: "Market prices", agent: "market-watcher", render: r(mk, (d) => <PricesView report={d} />) },
        { id: "dates", label: "Dates ahead", agent: "marketer", render: r(mk, (d) => <FestivalsView report={d} />) },
      ];
    case "social":
      return [
        { id: "results", label: "Results", agent: "social-media-manager", render: r(so, (d) => <SocialResultsView report={d} />) },
        { id: "inbox", label: "Messages and reviews", agent: "social-media-manager", render: r(so, (d) => <SocialInboxView report={d} />) },
        { id: "posts", label: "Posts", agent: "social-media-manager", render: r(so, (d) => <PostsView report={d} />) },
        { id: "calendar", label: "Calendar", agent: "social-media-manager", render: r(so, (d) => <CalendarView report={d} />) },
      ];
    case "operations":
      return [
        { id: "stock", label: "Stock", agent: "storekeeper", render: r(op, (d) => <StockView report={d} />) },
        { id: "orders", label: "Buying", agent: "buyer", render: r(op, (d) => <OrdersView report={d} />) },
        { id: "compliance", label: "Compliance", agent: "compliance-officer", render: r(op, (d) => <ComplianceView report={d} />) },
      ];
    case "people":
      return [{ id: "payroll", label: "Payroll", agent: "payroll-clerk", render: r(pe, (d) => <PayrollView report={d} />) }];
  }
  return [];
}

const BOARD_TEAMS = TEAMS.filter((t) => t.id !== "front");

export function BoardroomScreen() {
  const params = useParams({ strict: false }) as { team?: string; tab?: string };
  const office = useQuery(q.office());
  const isHired = (agentId: string) => office.data?.rooms.find((r) => r.agentId === agentId)?.hired ?? true;
  const staffed = BOARD_TEAMS.filter((t) => AGENTS.some((a) => a.team === t.id && isHired(a.id)));
  const shownTeams = staffed.length ? staffed : BOARD_TEAMS;
  const team = BOARD_TEAMS.find((t) => t.id === params.team) ?? shownTeams[0]!;
  const tabs = useTabs(team.id);
  const tab = tabs.find((t) => t.id === params.tab) ?? tabs.find((t) => isHired(t.agent)) ?? tabs[0]!;
  const content = tab.render();
  const hired = isHired(tab.agent);
  const agent = AGENT_BY_ID[tab.agent]!;
  const teamTabs = shownTeams.some((t) => t.id === team.id) ? shownTeams : [...shownTeams, team];
  const hiredTabs = tabs.filter((t) => isHired(t.agent));
  const otherTabs = tabs.filter((t) => !isHired(t.agent));
  const otherTeams = BOARD_TEAMS.filter((t) => !teamTabs.includes(t));
  const others = otherTabs.length + otherTeams.length;
  const reportLink = (t: Tab) => (
    <Link key={t.id} to="/boardroom/$team/$tab" params={{ team: team.id, tab: t.id }} aria-current={t.id === tab.id ? "page" : undefined}>
      {t.label}
    </Link>
  );

  return (
    <Page ready={content.ready} error={content.error} wide>
      <PageHead title="Boardroom" lede="Every report your team keeps. Underlined figures open the documents they were added up from." />
      {teamTabs.length > 1 ? (
        <nav className="tabs board-teams" aria-label="Teams">
          {teamTabs.map((t) => (
            <Link key={t.id} to="/boardroom/$team" params={{ team: t.id }} aria-current={t.id === team.id ? "page" : undefined}>
              {t.name}
            </Link>
          ))}
        </nav>
      ) : null}
      <div className="board">
        <nav className="board-reports" aria-label={`${team.name} reports`}>
          {hiredTabs.map(reportLink)}
          {others ? (
            <details className="board-others" open={!hired || !hiredTabs.length}>
              <summary>Reports from agents you haven't hired ({others})</summary>
              {otherTabs.map(reportLink)}
              {otherTeams.map((t) => (
                <Link key={t.id} to="/boardroom/$team" params={{ team: t.id }}>
                  {t.name}
                </Link>
              ))}
            </details>
          ) : null}
        </nav>
        <div className="board-body">
          {!hired ? (
            <p className="preview-note">
              Preview. {agent.title} is not on your team, so this report is not kept up to date and nothing in it is acted on.{" "}
              <Link to="/hiring">Hire {theAgent(agent.id)}</Link>
            </p>
          ) : null}
          {content.node}
          <p className="board-keeper muted">
            Kept by <Link to="/rooms/$agentId" params={{ agentId: agent.id }}>{theAgent(agent.id)}</Link>.
          </p>
        </div>
      </div>
    </Page>
  );
}

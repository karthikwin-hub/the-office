import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter } from "@tanstack/react-router";
import { AuditScreen } from "../screens/Audit";
import { BoardroomScreen } from "../screens/Boardroom";
import { DeskScreen } from "../screens/Desk";
import { FloorScreen } from "../screens/Floor";
import { HiringScreen } from "../screens/Hiring";
import { NotFound } from "../screens/common";
import { PartyScreen } from "../screens/Party";
import { RoomScreen } from "../screens/Room";
import { SettingsScreen } from "../screens/Settings";
import { Shell } from "./Shell";

/** Overlay state lives in the URL so any proof can be linked and screenshotted. */
export type OverlaySearch = { figure?: string; doc?: string; region?: string; ask?: string; as?: string };

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Shell,
  notFoundComponent: NotFound,
  validateSearch: (s: Record<string, unknown>): OverlaySearch => ({
    figure: typeof s.figure === "string" ? s.figure : undefined,
    doc: typeof s.doc === "string" ? s.doc : undefined,
    region: typeof s.region === "string" ? s.region : undefined,
    ask: typeof s.ask === "string" ? s.ask : undefined,
    as: typeof s.as === "string" ? s.as : undefined,
  }),
});

const floor = createRoute({ getParentRoute: () => root, path: "/", component: FloorScreen });
const room = createRoute({ getParentRoute: () => root, path: "/rooms/$agentId", component: RoomScreen });
const boardroom = createRoute({ getParentRoute: () => root, path: "/boardroom", component: BoardroomScreen });
const boardroomTeam = createRoute({ getParentRoute: () => root, path: "/boardroom/$team", component: BoardroomScreen });
const boardroomTab = createRoute({ getParentRoute: () => root, path: "/boardroom/$team/$tab", component: BoardroomScreen });
const audit = createRoute({ getParentRoute: () => root, path: "/audit", component: AuditScreen });
const desk = createRoute({ getParentRoute: () => root, path: "/desk", component: DeskScreen });
const hiring = createRoute({ getParentRoute: () => root, path: "/hiring", component: HiringScreen });
const settings = createRoute({ getParentRoute: () => root, path: "/settings", component: SettingsScreen });
const party = createRoute({ getParentRoute: () => root, path: "/parties/$partyId", component: PartyScreen });

export const router = createRouter({
  routeTree: root.addChildren([floor, room, boardroom, boardroomTeam, boardroomTab, audit, desk, hiring, settings, party]),
  context: { queryClient: undefined! },
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

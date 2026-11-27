// How the sweep (visual/sweep.spec.ts) reaches every page of this app: the
// routes, the states it opens them in, the language switch. Runs in the
// app's folder (project.json "app"), so it may use the app's own e2e helpers.
// Another frontend replaces this file and project.json; the kit stays as it is.
import { expect, type Page } from "@playwright/test";

import { open as openScenario, orgPath } from "../e2e/app";
import { params, routes as appRoutes } from "../e2e/routes";
import { sourceOf } from "../e2e/sources";

/** Every route to photograph, as the app names them (a parameter as `$name`). */
export const routes: string[] = appRoutes;

/** Routes that only redirect, to a page the sweep visits anyway. */
export const skip = new Set(["/step-up-complete", "/operator", "/o/$orgId"]);

/**
 * The mock's states the sweep opens, in order; a route is photographed in the
 * first one whose `covers` takes it. The operator area opens only for an
 * installation's administrator: any other scenario sees its "elevate first" notice.
 */
export const scenarios = [
  { name: "admin", covers: (route: string) => !route.startsWith("/operator") },
  { name: "partner", covers: (route: string) => !route.startsWith("/operator") },
  { name: "installationAdmin", covers: (route: string) => route.startsWith("/operator") },
];

/** Opens the app in a scenario, signed in. */
export async function open(page: Page, scenario: string) {
  await openScenario(page, scenario);
}

/** Text of the app's own development tools, which the checks and Grok leave out. */
export const ignore = "details:has(#mock-scenario)";

/** Opens a page and waits until it has settled. */
export async function ready(page: Page, path: string) {
  await page.goto(path);
  await page.locator("main").or(page.getByRole("status")).first().waitFor({ timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
}

/** The language as a person would set it: their own setting and the organization's, through the mock's API. */
export async function setLanguage(page: Page, lang: string, source: string) {
  if (lang === source) return;
  const orgId = orgPath.split("/").pop();
  await page.evaluate(
    async ({ orgId, lang }) => {
      for (const layer of ["user", "organization"])
        await fetch(`/api/v1/organizations/${orgId}/settings/locale.language`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ layer, value: lang }),
        }).catch(() => undefined);
    },
    { orgId, lang },
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
}

// Route params, resolved as e2e/surfaces.ts does.
const cuts = (route: string) => [...route.matchAll(/\/\$[^/]+/g)].length;
const pattern = (route: string) =>
  new RegExp(`^${route.replace(/[.*+?^{}()|[\]\\]/g, "\\$&").replace(/\/\$[^/]+/g, "/[^/]+")}(?=/|$)`);

/** A path to open for each route the current scenario can reach, its parameters filled from the mock's data. */
export async function paths(page: Page): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  const concrete = (route: string) => {
    if (!route.includes("$")) return route;
    const source = sourceOf(route, params);
    const value = source && values.get(source);
    return value === undefined ? undefined : value + route.slice(source!.length);
  };
  const words = new Set(routes.map((r) => r.split("/").pop()!).filter((part) => !part.startsWith("$")));
  const sources = Object.entries(params).sort(([a], [b]) => cuts(a) - cuts(b) || a.length - b.length);
  for (const [route, source] of sources) {
    const from = concrete(source.from);
    if (from === undefined) continue;
    const shape = pattern(source.link ?? route);
    if (shape.test(from)) {
      values.set(route, from);
      continue;
    }
    try {
      await ready(page, from);
    } catch {
      continue;
    }
    const candidates = await page.evaluate(() => [
      location.pathname,
      ...[...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map((a) => new URL(a.href).pathname),
    ]);
    const hit = candidates.map((p) => shape.exec(p)?.[0]).find((p) => p && !words.has(p.split("/").pop()!));
    const parent = source.link && concrete(route.slice(0, route.lastIndexOf("/$")));
    if (hit) values.set(route, parent ? `${parent}/${hit.split("/").pop()}` : hit);
  }
  const found = new Map<string, string>();
  for (const route of routes) {
    const path = concrete(route);
    if (path !== undefined) found.set(route, path);
  }
  return found;
}

// Opens every route of the app (e2e/routes.ts) in each variant (language,
// device, theme), screenshots it and records what can be checked without a
// person: console errors, sideways scrolling, cut-off text, raw text keys,
// unfilled placeholders and English left on German or Spanish pages.
// Writes /out/shots/<route>/<variant>.png and /out/sweep/<variant>.json.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { open, orgPath } from "../e2e/app";
import { params, routes } from "../e2e/routes";
import { sourceOf } from "../e2e/sources";

type Lang = "en" | "de" | "es";
type Device = "desktop" | "phone" | "tablet" | "wide" | "qhd";
type Variant = { name: string; lang: Lang; device: Device; theme: "light" | "dark"; extra?: true };
// Each window is two screens tall: a column that scrolls on its own (the case
// page's side rail) is as tall as the window, so in a one-screen window its
// lower cards never reach the screenshot.
const devices: Record<Device, { width: number; height: number; touch: boolean }> = {
  phone: { width: 390, height: 844 * 2, touch: true }, // iPhone 12-16
  tablet: { width: 820, height: 1180 * 2, touch: true }, // iPad Air, upright
  desktop: { width: 1440, height: 900 * 2, touch: false }, // laptop, office monitor
  wide: { width: 1920, height: 1080 * 2, touch: false }, // Full HD
  qhd: { width: 2560, height: 1440 * 2, touch: false }, // QHD
};

const out = process.env.SWEEP_OUT ?? "/out";
const web = join(import.meta.dirname, "..");
// A fixed clock: the mock's "5 minutes ago" data stays the same between runs,
// so an unchanged page gives an unchanged screenshot and is not reviewed again.
const time = new Date("2026-11-02T09:30:00+01:00");
const skip = new Set(["/step-up-complete"]);
const locales: Record<Lang, string> = { en: "en-US", de: "de-AT", es: "es-ES" };

const all: Variant[] = [
  { name: "en-desktop-light", lang: "en", device: "desktop", theme: "light" },
  { name: "en-desktop-dark", lang: "en", device: "desktop", theme: "dark" },
  { name: "en-phone-light", lang: "en", device: "phone", theme: "light" },
  { name: "en-phone-dark", lang: "en", device: "phone", theme: "dark" },
  { name: "de-desktop-light", lang: "de", device: "desktop", theme: "light" },
  { name: "de-phone-light", lang: "de", device: "phone", theme: "light" },
  { name: "es-desktop-light", lang: "es", device: "desktop", theme: "light" },
  { name: "es-phone-light", lang: "es", device: "phone", theme: "light" },
  // The extra sizes, swept only when SWEEP_VARIANTS names them.
  { name: "en-tablet-light", lang: "en", device: "tablet", theme: "light", extra: true },
  { name: "en-tablet-dark", lang: "en", device: "tablet", theme: "dark", extra: true },
  { name: "de-tablet-light", lang: "de", device: "tablet", theme: "light", extra: true },
  { name: "es-tablet-light", lang: "es", device: "tablet", theme: "light", extra: true },
  { name: "en-wide-light", lang: "en", device: "wide", theme: "light", extra: true },
  { name: "en-wide-dark", lang: "en", device: "wide", theme: "dark", extra: true },
  { name: "de-wide-light", lang: "de", device: "wide", theme: "light", extra: true },
  { name: "es-wide-light", lang: "es", device: "wide", theme: "light", extra: true },
  { name: "en-qhd-light", lang: "en", device: "qhd", theme: "light", extra: true },
  { name: "en-qhd-dark", lang: "en", device: "qhd", theme: "dark", extra: true },
];
// SWEEP_VARIANTS: names or parts of names ("tablet", "wide qhd", "de-", "all");
// without it, the 8 basic variants.
const wanted = (process.env.SWEEP_VARIANTS ?? "").split(/\s+/).filter(Boolean);
const variants = !wanted.length
  ? all.filter((v) => !v.extra)
  : wanted.includes("all")
    ? all
    : all.filter((v) => wanted.some((w) => v.name.includes(w)));
// SWEEP_ONLY=<regular expression>: only the routes it matches, e.g. "inbox|cases".
const only = process.env.SWEEP_ONLY ? new RegExp(process.env.SWEEP_ONLY) : undefined;

// The app's texts, by language: "<namespace>#<key>" to text.
function localeFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) localeFiles(path, found);
    else if (/\/locales\/(?:[\w-]+\.)?(en|de|es)\.json$/.test(path)) found.push(path);
  }
  return found;
}
function flatten(value: unknown, prefix: string, into: Map<string, string>) {
  if (typeof value === "string") into.set(prefix, value);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) flatten(v, prefix.endsWith("#") ? prefix + k : `${prefix}.${k}`, into);
}
const texts: Record<Lang, Map<string, string>> = { en: new Map(), de: new Map(), es: new Map() };
for (const file of localeFiles(join(web, "src"))) {
  const [, prefix, lang] = /\/locales\/(?:([\w-]+)\.)?(en|de|es)\.json$/.exec(file)!;
  const ns = relative(join(web, "src"), dirname(dirname(file))) + (prefix ? `/${prefix}` : "");
  flatten(JSON.parse(readFileSync(file, "utf8")), `${ns}#`, texts[lang as Lang]);
}
// Keys as i18next shows them when a text is missing; plain words are left out.
const keyNames = new Set<string>();
for (const id of texts.en.keys()) {
  const key = id.split("#")[1];
  for (const k of [key, key.replace(/_(zero|one|two|few|many|other)$/, "")])
    if (/[._]|[a-z][A-Z]/.test(k)) keyNames.add(k);
}
// English sentences that a German or Spanish page should not show.
function englishOnly(lang: Lang): Set<string> {
  const own = new Set(texts[lang].values());
  const found = new Set<string>();
  for (const [id, en] of texts.en) {
    if (en.length < 8 || en.split(/\s+/).length < 2 || en.includes("{{")) continue;
    if (texts[lang].get(id) !== en && !own.has(en)) found.add(en);
  }
  return found;
}

// Route params, resolved as e2e/surfaces.ts does.
const cuts = (route: string) => [...route.matchAll(/\/\$[^/]+/g)].length;
const pattern = (route: string) =>
  new RegExp(`^${route.replace(/[.*+?^{}()|[\]\\]/g, "\\$&").replace(/\/\$[^/]+/g, "/[^/]+")}(?=/|$)`);

async function settle(page: Page, path: string) {
  await page.goto(path);
  await page.locator("main").or(page.getByRole("status")).first().waitFor({ timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
}

async function resolve(page: Page): Promise<Map<string, string>> {
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
      await settle(page, from);
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
  const paths = new Map<string, string>();
  for (const route of routes) {
    const path = concrete(route);
    if (path !== undefined) paths.set(route, path);
  }
  return paths;
}

// The language as a person would set it: their own setting and the
// organization's, through the mock's API.
async function setLanguage(page: Page, lang: Lang) {
  if (lang === "en") return;
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

// Runs in the page. `boxes` is the text inside the screenshot (above
// `limit`), each piece with where it stands on the screenshot: Grok's
// findings must quote from it, and the report marks a finding's spot by it.
function inspect(limit: number) {
  const ignored = (el: Element) => el.closest("details:has(#mock-scenario), script, style, noscript");
  const shown = new Set<string>();
  const boxes: [string, number, number, number, number][] = [];
  const at = (r: DOMRect): [number, number, number, number] => [
    Math.round(r.left + window.scrollX),
    Math.round(r.top + window.scrollY),
    Math.round(r.width),
    Math.round(r.height),
  ];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const el = walker.currentNode.parentElement;
    const text = walker.currentNode.textContent?.trim();
    if (!text || !el || ignored(el)) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    shown.add(text);
    if (box.top + window.scrollY < limit && boxes.length < 1500) {
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      boxes.push([text, ...at(range.getBoundingClientRect())]);
    }
  }
  const clipped: { text: string; box: [number, number, number, number] }[] = [];
  for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
    if (clipped.length >= 8 || ignored(el)) continue;
    if (![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())) continue;
    const box = el.getBoundingClientRect();
    if (box.width <= 2 || box.height <= 2) continue;
    const style = getComputedStyle(el);
    if (style.textOverflow === "ellipsis" || !/hidden|clip/.test(`${style.overflowX} ${style.overflowY}`)) continue;
    if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2)
      clipped.push({ text: `${el.tagName.toLowerCase()}: ${el.textContent!.trim().slice(0, 80)}`, box: at(box) });
  }
  // Text squeezed into a narrow column while the space beside it stays empty:
  // it runs over 2+ lines, its row (the ancestors about as tall as it) is at
  // least twice as wide, and nothing with content stands to its right there.
  const squeezed: { text: string; box: [number, number, number, number] }[] = [];
  const hasText = (el: Element) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
  const content = (el: Element) => hasText(el) || /^(svg|img|button|input|select|textarea|canvas)$/i.test(el.tagName);
  const lines = (el: Element) => {
    const tops = new Set<number>();
    for (const n of el.childNodes) {
      if (n.nodeType !== Node.TEXT_NODE || !n.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 1) tops.add(Math.round(r.top));
    }
    return tops.size;
  };
  for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
    if (squeezed.length >= 8 || ignored(el) || !hasText(el)) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 20 || box.width > 360 || box.top + window.scrollY >= limit || lines(el) < 2) continue;
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3;
    let row: HTMLElement = el;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (a.getBoundingClientRect().height > box.height + line * 3) break;
      row = a;
    }
    const area = row.getBoundingClientRect();
    if (area.width < box.width * 2) continue;
    let right = box.right;
    for (const other of row.querySelectorAll("*")) {
      if (other === el || el.contains(other) || other.contains(el) || !content(other)) continue;
      const r = other.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom <= box.top || r.top >= box.bottom) continue;
      right = Math.max(right, r.right);
    }
    const free = area.right - parseFloat(getComputedStyle(row).paddingRight || "0") - right;
    if (free > area.width * 0.3)
      squeezed.push({
        text: `"${el.textContent!.trim().replace(/\s+/g, " ").slice(0, 60)}" wraps in ${Math.round(box.width)} px while ${Math.round(free)} px beside it stay empty`,
        // The text and the empty space beside it.
        box: [...at(box).slice(0, 2), Math.round(area.right - box.left), Math.round(box.height)] as [number, number, number, number],
      });
  }
  return {
    squeezed,
    lang: document.documentElement.lang,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    width: window.innerWidth,
    height: document.documentElement.scrollHeight,
    texts: [...shown],
    boxes,
    clipped,
  };
}

function slug(route: string) {
  return route.replace(/^\//, "").replace(/\$/g, "").replace(/\//g, "__") || "root";
}

for (const v of variants)
  test(v.name, async ({ browser }) => {
    test.setTimeout(60 * 60_000);
    const { touch, ...viewport } = devices[v.device];
    const context = await browser.newContext({
      viewport,
      hasTouch: touch,
      colorScheme: v.theme,
      locale: locales[v.lang],
      reducedMotion: "reduce",
      baseURL: test.info().project.use.baseURL,
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(time);
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text().slice(0, 300));
    });
    page.on("pageerror", (e) => errors.push(`Uncaught: ${e.message.slice(0, 300)}`));
    const english = v.lang === "en" ? new Set<string>() : englishOnly(v.lang);
    // Screenshots stop at the window's height: the rest of a long page adds cost, rarely findings.
    const maxHeight = viewport.height;
    const records: Record<string, unknown>[] = [];
    const done = new Set<string>();

    for (const scenario of ["admin", "partner"]) {
      await open(page, scenario);
      await setLanguage(page, v.lang);
      const paths = await resolve(page);
      for (const route of routes) {
        const path = paths.get(route);
        if (done.has(route) || skip.has(route) || !path || (only && !only.test(route))) continue;
        done.add(route);
        const record: Record<string, unknown> = { route, path, scenario };
        records.push(record);
        errors.length = 0;
        try {
          await settle(page, path);
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(250);
          const seen = await page.evaluate(inspect, maxHeight);
          record.boxes = seen.boxes;
          record.lang = seen.lang;
          if (seen.overflowX > 1) record.overflowX = seen.overflowX;
          if (seen.clipped.length) record.clipped = seen.clipped;
          if (seen.squeezed.length) record.squeezed = seen.squeezed;
          const rawKeys = seen.texts.filter((t) => keyNames.has(t.replace(/^[\w/-]+:/, "")));
          if (rawKeys.length) record.rawKeys = rawKeys.slice(0, 10);
          const placeholders = seen.texts.filter((t) => /\{\{|\}\}/.test(t));
          if (placeholders.length) record.placeholders = placeholders.slice(0, 10);
          const left = seen.texts.filter((t) => english.has(t));
          if (left.length) record.english = left.slice(0, 10);
          const shot = join("shots", slug(route), `${v.name}.png`);
          mkdirSync(dirname(join(out, shot)), { recursive: true });
          // The window as it is, exactly as it was measured: a full-page capture
          // would stretch the window and move what the phone layout shows.
          await page.screenshot({ path: join(out, shot), animations: "disabled", caret: "hide" });
          record.shot = shot;
        } catch (e) {
          record.failed = String(e).split("\n")[0].slice(0, 300);
        }
        if (errors.length) record.consoleErrors = [...new Set(errors)].slice(0, 10);
      }
    }
    for (const route of routes)
      if (!done.has(route) && !skip.has(route) && (!only || only.test(route))) records.push({ route, notReached: true });
    mkdirSync(join(out, "sweep"), { recursive: true });
    writeFileSync(join(out, "sweep", `${v.name}.json`), JSON.stringify(records, null, 1));
    await context.close();
  });

// Opens every route of the app (project/pages.ts) in each variant (language,
// device, theme), screenshots it and records what can be checked without a
// person: console errors, sideways scrolling, cut-off text, raw text keys,
// unfilled placeholders and source-language text left on pages in another language.
// Writes /out/shots/<route>/<variant>.png and /out/sweep/<variant>.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { test } from "@playwright/test";

import { ignore, open, paths as pathsOf, ready, routes, scenarios, setLanguage, skip } from "../grok-project/pages";
import { DEVICES, LANGS, project, readTexts, SOURCE, VARIANTS } from "./project.mjs";

const out = process.env.SWEEP_OUT ?? "/out";
const app = join(import.meta.dirname, "..");
// A fixed clock (project.json "clock"): "5 minutes ago" in the app's data stays the same between runs,
// so an unchanged page gives an unchanged screenshot and is not reviewed again.
const time = new Date(project.clock);

// SWEEP_VARIANTS: names or parts of names ("tablet", "wide qhd", "de-", "all");
// without it, the basic variants (desktop and phone).
const wanted = (process.env.SWEEP_VARIANTS ?? "").split(/\s+/).filter(Boolean);
const variants = !wanted.length
  ? VARIANTS.filter((v) => !v.extra)
  : wanted.includes("all")
    ? VARIANTS
    : VARIANTS.filter((v) => wanted.some((w) => v.name.includes(w)));
// SWEEP_ONLY=<regular expression>: only the routes it matches, e.g. "inbox|cases".
const only = process.env.SWEEP_ONLY ? new RegExp(process.env.SWEEP_ONLY) : undefined;

// The app's texts, by language: "<namespace>#<key>" to text.
const texts: Record<string, Map<string, string>> = Object.fromEntries(LANGS.map((l) => [l, new Map()]));
for (const [ns, entry] of readTexts(join(app, project.texts.dir)))
  for (const lang of LANGS) for (const [key, text] of Object.entries(entry[lang] as Record<string, string>)) texts[lang].set(`${ns}#${key}`, text);
// Keys as i18next shows them when a text is missing; plain words are left out.
const keyNames = new Set<string>();
for (const id of texts[SOURCE].keys()) {
  const key = id.split("#")[1];
  for (const k of [key, key.replace(/_(zero|one|two|few|many|other)$/, "")])
    if (/[._]|[a-z][A-Z]/.test(k)) keyNames.add(k);
}
// Source-language sentences that a page in another language should not show.
function untranslated(lang: string): Set<string> {
  const own = new Set(texts[lang].values());
  const found = new Set<string>();
  for (const [id, text] of texts[SOURCE]) {
    if (text.length < 8 || text.split(/\s+/).length < 2 || text.includes("{{")) continue;
    if (texts[lang].get(id) !== text && !own.has(text)) found.add(text);
  }
  return found;
}

// Runs in the page. `boxes` is the text inside the screenshot (above
// `limit`), each piece with where it stands on the screenshot: Grok's
// findings must quote from it, and the report marks a finding's spot by it.
function inspect({ limit, ignore }: { limit: number; ignore: string }) {
  const ignored = (el: Element) => el.closest(ignore ? `${ignore}, script, style, noscript` : "script, style, noscript");
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
  // Rows that scroll sideways (tab bars): text cut off at their edge is
  // intended (review-notes.md), so Grok's claims about it are rejected.
  const scrollers: [number, number, number, number][] = [];
  for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
    if (scrollers.length >= 20 || ignored(el) || el.scrollWidth <= el.clientWidth + 2) continue;
    if (!/auto|scroll/.test(getComputedStyle(el).overflowX)) continue;
    const box = el.getBoundingClientRect();
    if (box.width && box.height && box.height < 120 && box.top + window.scrollY < limit) scrollers.push(at(box));
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
    scrollers,
  };
}

function slug(route: string) {
  return route.replace(/^\//, "").replace(/\$/g, "").replace(/\//g, "__") || "root";
}

for (const v of variants)
  test(v.name, async ({ browser }) => {
    test.setTimeout(60 * 60_000);
    const { touch, label: _, ...viewport } = DEVICES[v.device as keyof typeof DEVICES];
    const context = await browser.newContext({
      viewport,
      hasTouch: touch,
      colorScheme: v.theme as "light" | "dark",
      locale: project.languages[v.lang].locale,
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
    const foreign = v.lang === SOURCE ? new Set<string>() : untranslated(v.lang);
    // Screenshots stop at the window's height: the rest of a long page adds cost, rarely findings.
    const maxHeight = viewport.height;
    const records: Record<string, unknown>[] = [];
    const done = new Set<string>();

    // Each route in the first scenario that covers it (project/pages.ts).
    for (const scenario of scenarios) {
      await open(page, scenario.name);
      await setLanguage(page, v.lang, SOURCE);
      const paths = await pathsOf(page);
      for (const route of routes) {
        const path = paths.get(route);
        if (!scenario.covers(route)) continue;
        if (done.has(route) || skip.has(route) || !path || (only && !only.test(route))) continue;
        done.add(route);
        const record: Record<string, unknown> = { route, path, scenario: scenario.name };
        records.push(record);
        errors.length = 0;
        try {
          await ready(page, path);
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(250);
          const seen = await page.evaluate(inspect, { limit: maxHeight, ignore });
          record.boxes = seen.boxes;
          record.lang = seen.lang;
          if (seen.overflowX > 1) record.overflowX = seen.overflowX;
          if (seen.clipped.length) record.clipped = seen.clipped;
          if (seen.squeezed.length) record.squeezed = seen.squeezed;
          if (seen.scrollers.length) record.scrollers = seen.scrollers;
          const rawKeys = seen.texts.filter((t) => keyNames.has(t.replace(/^[\w/-]+:/, "")));
          if (rawKeys.length) record.rawKeys = rawKeys.slice(0, 10);
          const placeholders = seen.texts.filter((t) => /\{\{|\}\}/.test(t));
          if (placeholders.length) record.placeholders = placeholders.slice(0, 10);
          const left = seen.texts.filter((t) => foreign.has(t));
          if (left.length) record.untranslated = left.slice(0, 10);
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

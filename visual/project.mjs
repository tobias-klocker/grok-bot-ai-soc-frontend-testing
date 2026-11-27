// The frontend under test, as project/project.json describes it: its
// languages, its text files and the variants they give. Everything else in
// visual/ is the same for every frontend.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const file = process.env.REVIEW_PROJECT ?? resolve(import.meta.dirname, "../project/project.json");
if (!existsSync(file)) throw new Error(`No project description at ${file} (README.md, "Another frontend")`);
export const project = JSON.parse(readFileSync(file, "utf8"));

/** Language codes, the source first; a code has no dash (it starts a variant's name). */
export const SOURCE = project.source;
export const LANGS = [SOURCE, ...Object.keys(project.languages).filter((l) => l !== SOURCE)];
export const TARGETS = LANGS.slice(1);
export const nameOf = (lang) => project.languages[lang]?.name ?? lang;
export const informal = Object.fromEntries(
  TARGETS.filter((l) => project.languages[l].informal).map((l) => [l, new RegExp(project.languages[l].informal, "iu")]),
);

// ---------------------------------------------------------------- variants
// A variant is <language>-<device>-<theme>. Each window is two screens tall: a
// column that scrolls on its own (a side rail) is as tall as the window, so in
// a one-screen window its lower cards never reach the screenshot.
export const DEVICES = {
  phone: { width: 390, height: 844 * 2, touch: true, label: "phone" }, // iPhone 12-16
  tablet: { width: 820, height: 1180 * 2, touch: true, label: "tablet" }, // iPad Air, upright
  desktop: { width: 1440, height: 900 * 2, touch: false, label: "desktop" }, // laptop, office monitor
  wide: { width: 1920, height: 1080 * 2, touch: false, label: "large desktop" }, // Full HD
  qhd: { width: 2560, height: 1440 * 2, touch: false, label: "large desktop" }, // QHD
};
// The source language in light and dark, the others in light; QHD only in the source.
const plan = [
  ["desktop", false],
  ["phone", false],
  ["tablet", true],
  ["wide", true],
  ["qhd", true],
];
export const VARIANTS = plan.flatMap(([device, extra]) =>
  LANGS.flatMap((lang) =>
    lang === SOURCE
      ? ["light", "dark"].map((theme) => ({ name: `${lang}-${device}-${theme}`, lang, device, theme, extra }))
      : device === "qhd"
        ? []
        : [{ name: `${lang}-${device}-light`, lang, device, theme: "light", extra }],
  ),
).sort((a, b) => Number(a.extra) - Number(b.extra) || order(a) - order(b));
function order(v) {
  const lang = LANGS.indexOf(v.lang);
  const device = plan.findIndex(([d]) => d === v.device);
  return v.extra ? device * 100 + lang * 10 + (v.theme === "dark") : lang * 100 + device * 10 + (v.theme === "dark");
}
/** What Grok reviews unless REVIEW_VARIANTS says otherwise: the source on desktop (both themes) and phone, the others on phone. */
export const REVIEWED = [`${SOURCE}-desktop-light`, `${SOURCE}-phone-light`, `${SOURCE}-desktop-dark`, ...TARGETS.map((l) => `${l}-phone-light`)];
export function describe(variant) {
  const [lang, device, theme] = variant.split("-");
  const d = DEVICES[device];
  return d ? `${nameOf(lang)}, ${d.label} ${d.width} px, ${theme} theme` : variant;
}

// ---------------------------------------------------------------- texts
/** The pattern of a text file's path: group 1 a prefix that names its own namespace, group 2 the language. */
export const textFile = new RegExp(project.texts.file.replace("{lang}", LANGS.join("|")));

function filesUnder(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesUnder(path, found);
    else if (textFile.test(path)) found.push(path);
  }
  return found;
}
function flatten(value, prefix, into) {
  if (typeof value === "string") into[prefix] = value;
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, into);
  return into;
}
/**
 * The app's texts under `src`, by namespace (the folder that holds the text
 * files' folder, and a file's prefix): { <lang>: { key: text }, raw }, where
 * raw is the files' text joined, for noticing a change.
 */
export function readTexts(src) {
  const namespaces = new Map();
  for (const path of filesUnder(src).sort()) {
    const [, prefix, lang] = textFile.exec(path);
    const ns = relative(src, dirname(dirname(path))) + (prefix ? `/${prefix}` : "");
    const entry = namespaces.get(ns) ?? { ...Object.fromEntries(LANGS.map((l) => [l, {}])), raw: "" };
    const raw = readFileSync(path, "utf8");
    entry[lang] = flatten(JSON.parse(raw), "", {});
    entry.raw += raw;
    namespaces.set(ns, entry);
  }
  return namespaces;
}

// The same finding in several variants of one page (another language,
// another theme) once, naming every variant: one decision covers them all.
// Two findings are the same when they come from the same source and kind, on
// the same device, and quote the same text key in their languages (or the
// same text), or stand at about the same place on their screenshots.
// No two members share a variant: two findings of one screenshot stay two.
import { norm } from "./verdicts.mjs";

const order = { high: 0, medium: 1, low: 2 };
const deviceOf = (variant) => variant.split("-")[1];
const devicesOf = (variants) => [...new Set(variants.map(deviceOf))].sort().join(" ");
// What kind of check it is ("Text squeezed into a narrow column"); Grok's are all one kind.
// The language a check names is not its kind: "English text on the German page" and
// "… on the Spanish page" about the same text are one finding.
const kindOf = (f) => (f.source === "grok" ? "grok" : f.problem.split(/[:(]/)[0].replace(/\b(German|Spanish)\b/g, "").trim());

// Most of the smaller box lies inside the other.
function overlaps(a, b) {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return false;
  return w * h >= 0.5 * Math.min(a[2] * a[3], b[2] * b[3]);
}

// keysOf(text, language): the text keys whose text in that language is this
// text, so "Reports" in English and "Berichte" in German are one anchor.
export function mergeVariants(route, findings, keysOf) {
  const items = findings
    .map((f) => {
      const variants = String(f.variant ?? "").split(",").map((v) => v.trim()).filter(Boolean);
      const anchors = new Set();
      if (f.quote) {
        anchors.add(`q:${norm(f.quote)}`);
        for (const v of variants) for (const k of keysOf(f.quote, v.slice(0, 2))) anchors.add(`k:${k}`);
      }
      return { f, variants, anchors, boxes: (f.spots ?? []).map((s) => s.box) };
    })
    .sort((a, b) => (order[a.f.severity] ?? 3) - (order[b.f.severity] ?? 3) || Number(!a.variants.some((v) => v.startsWith("en"))) - Number(!b.variants.some((v) => v.startsWith("en"))));

  const groups = [];
  for (const it of items) {
    const group = groups.find(
      (g) =>
        g.source === it.f.source &&
        g.kind === kindOf(it.f) &&
        g.devices === devicesOf(it.variants) &&
        !it.variants.some((v) => g.variants.has(v)) &&
        ([...it.anchors].some((a) => g.anchors.has(a)) || it.boxes.some((b) => g.boxes.some((c) => overlaps(b, c)))),
    );
    if (group) {
      group.items.push(it);
      it.variants.forEach((v) => group.variants.add(v));
      it.anchors.forEach((a) => group.anchors.add(a));
      group.boxes.push(...it.boxes);
    } else
      groups.push({
        source: it.f.source,
        kind: kindOf(it.f),
        devices: devicesOf(it.variants),
        variants: new Set(it.variants),
        anchors: new Set(it.anchors),
        boxes: [...it.boxes],
        items: [it],
      });
  }

  return groups.map(({ items: [first, ...rest] }) => {
    const all = [first, ...rest];
    const members = all.map(({ f }) => ({ variant: f.variant, severity: f.severity, problem: f.problem, quote: f.quote, where: f.where, source: f.source }));
    return {
      ...first.f,
      route,
      variant: all.flatMap((it) => it.variants).join(", "),
      spots: all.flatMap(({ f }) => f.spots ?? []),
      stale: all.some(({ f }) => f.stale) || undefined,
      members,
    };
  });
}

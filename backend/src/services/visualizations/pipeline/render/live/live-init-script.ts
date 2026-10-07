/**
 * The live page init script (16 §12.5, E20): `Math.random` seeded exactly like the screenshot determinism script, and
 * `Date`/`Date.now` shifted so the page starts at the screenshots' fixed time and then advances normally. Animations
 * and transitions stay on. Injected as the first child of `<head>` by the Vite live plugin and the Angular static
 * host.
 *
 * PURE: imported by the Vite host child (10 §5.2). Imports only page-scripts (itself pure) and render.config.
 */
import { RENDER_FIXED_TIME_ISO, RENDER_RANDOM_SEED } from "../../../../../config-consts/render.config";
import { buildSeededRandomSource } from "../page-scripts";

/** `id` of the injected `<script>` (lets tests and the page tell it apart). */
export const LIVE_INIT_SCRIPT_ID = "prvision-live-init";

/**
 * The init script source (an IIFE, no `<script>` tag).
 *
 * @param seed - Random seed; defaults to RENDER_RANDOM_SEED (the screenshots' seed).
 * @param fixedTimeIso - Start time of the page clock; defaults to RENDER_FIXED_TIME_ISO.
 * @throws Error when `fixedTimeIso` is not a parseable date.
 */
export function buildLiveInitScript(
  seed: number = RENDER_RANDOM_SEED,
  fixedTimeIso: string = RENDER_FIXED_TIME_ISO
): string {
  const startMs = Date.parse(fixedTimeIso);
  if (!Number.isFinite(startMs)) {
    throw new Error(`Invalid live start time ${fixedTimeIso}`);
  }
  return `(() => {
${buildSeededRandomSource(seed)}
  const RealDate = Date;
  const offset = ${String(startMs)} - RealDate.now();
  const shiftedNow = () => RealDate.now() + offset;
  function PrvisionDate(...args) {
    if (!new.target) return new RealDate(shiftedNow()).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [shiftedNow()] : args, new.target);
  }
  Object.setPrototypeOf(PrvisionDate, RealDate);
  PrvisionDate.prototype = RealDate.prototype;
  PrvisionDate.now = function now() { return shiftedNow(); };
  globalThis.Date = PrvisionDate;
})();`;
}

/** `<script id="prvision-live-init">…</script>` for the given source (`</script` inside is escaped). */
export function liveInitScriptTag(source: string = buildLiveInitScript()): string {
  return `<script id="${LIVE_INIT_SCRIPT_ID}">${source.replace(/<\/script/gi, "<\\/script")}</script>`;
}

const HEAD_OPEN = /<head(?:\s[^>]*)?>/i;
const HTML_OPEN = /<html(?:\s[^>]*)?>/i;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;

/**
 * Inserts the init script tag as the first child of `<head>`. A document without `<head>` gets one right after
 * `<html>` (or at the very start). Already-injected documents are returned unchanged.
 *
 * @param html - The HTML document.
 * @param tag - From `liveInitScriptTag()`.
 */
export function injectLiveInitScript(html: string, tag: string = liveInitScriptTag()): string {
  if (html.includes(`id="${LIVE_INIT_SCRIPT_ID}"`)) {
    return html;
  }
  const head = HEAD_OPEN.exec(html);
  if (head !== null) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${tag}${html.slice(at)}`;
  }
  const root = HTML_OPEN.exec(html);
  if (root !== null) {
    const at = root.index + root[0].length;
    return `${html.slice(0, at)}<head>${tag}</head>${html.slice(at)}`;
  }
  const doctype = DOCTYPE.exec(html);
  const at = doctype === null ? 0 : doctype.index + doctype[0].length;
  return `${html.slice(0, at)}<head>${tag}</head>${html.slice(at)}`;
}

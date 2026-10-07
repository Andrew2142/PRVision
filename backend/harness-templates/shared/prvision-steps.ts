/*
 * PRVision step runtime (static template, sheet 16b §7.5). Framework-free; copied to <harnessDir>/prvision-steps.ts
 * for React and Angular and imported only by the render page entry (entry.tsx, main.ts), never by harness code.
 *
 * Screenshots: the backend marks a step's target through window.__PRVISION_MARK_STEP_TARGET__ and acts on it with
 * real Playwright input. Live mode: runStepsInPage replays the steps with synthetic events (hover is skipped).
 * Targets are found with DOM queries and text comparison only; test ids are exact attribute matches.
 */

export type StepTarget =
  | { by: 'role'; role: string; name: string; nth?: number }
  | { by: 'text'; text: string; nth?: number }
  | { by: 'label'; label: string; nth?: number }
  | { by: 'placeholder'; placeholder: string; nth?: number }
  | { by: 'testId'; testId: string; nth?: number };

export type StepKey =
  | 'Enter' | 'Escape' | 'Tab' | 'Space' | 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

export type Step =
  | { action: 'click'; target: StepTarget }
  | { action: 'hover'; target: StepTarget }
  | { action: 'focus'; target: StepTarget }
  | { action: 'type'; target: StepTarget; text: string }
  | { action: 'press'; key: StepKey; target?: StepTarget }
  | { action: 'waitFor'; target: StepTarget };

/** Implicit ARIA roles PRVision resolves; anything else must be an explicit role attribute. */
export const STEP_TARGET_ROLES = [
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'combobox', 'textbox', 'searchbox', 'listbox', 'slider', 'spinbutton', 'row', 'cell', 'gridcell',
  'heading', 'img', 'dialog', 'menu', 'tablist', 'treeitem',
] as const;

declare global {
  interface Window {
    __PRVISION_MARK_STEP_TARGET__?: (target: StepTarget, token: string) => { found: boolean; count: number };
  }
}

const MARK_ATTRIBUTE = 'data-prvision-step-target';
const POLL_MS = 100;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'TITLE']);
const TEXTBOX_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'password', 'number']);
const BUTTON_TYPES = new Set(['button', 'submit', 'reset', 'image']);

/** Unicode NFC, whitespace runs collapsed, trimmed, lower-cased (16 §7.5). */
function norm(value: string | null | undefined): string {
  return (value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function explicitRole(element: Element): string | null {
  const raw = element.getAttribute('role');
  if (raw === null) return null;
  const first = raw.trim().split(/\s+/)[0];
  return first === undefined || first === '' ? null : first.toLowerCase();
}

function implicitRole(element: Element): string | null {
  const tag = element.tagName.toLowerCase();
  switch (tag) {
    case 'button':
    case 'summary':
      return 'button';
    case 'a':
    case 'area':
      return element.hasAttribute('href') ? 'link' : null;
    case 'input': {
      const type = (element.getAttribute('type') ?? '').trim().toLowerCase();
      if (BUTTON_TYPES.has(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'search') return element.hasAttribute('list') ? 'combobox' : 'searchbox';
      if (element.hasAttribute('list') && TEXTBOX_TYPES.has(type)) return 'combobox';
      return TEXTBOX_TYPES.has(type) ? 'textbox' : null;
    }
    case 'textarea':
      return 'textbox';
    case 'select':
      return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return 'heading';
    case 'img': {
      const alt = element.getAttribute('alt');
      return alt !== null && alt !== '' ? 'img' : null;
    }
    case 'tr':
      return 'row';
    case 'td':
      return 'cell';
    case 'dialog':
      return 'dialog';
    default:
      return null;
  }
}

/** The explicit role (first token) when present, else the implicit role of the element. */
function roleOf(element: Element): string | null {
  return explicitRole(element) ?? implicitRole(element);
}

function isFormField(element: Element): boolean {
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function isVisible(element: Element): boolean {
  // getClientRects().length > 0 (16 §7.5); a zero-size box counts as not rendered, as for Playwright.
  if (!Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0)) return false;
  const view = element.ownerDocument.defaultView;
  if (view === null) return false;
  if (view.getComputedStyle(element).visibility === 'hidden') return false;
  const isDialog = roleOf(element) === 'dialog';
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node.hasAttribute('inert')) return false;
    if (view.getComputedStyle(node).display === 'none') return false;
    if (!isDialog && node.getAttribute('aria-hidden') === 'true') return false;
  }
  return true;
}

function textOfIds(root: Document, ids: string): string {
  return ids
    .split(/\s+/)
    .filter((id) => id !== '')
    .map((id) => root.getElementById(id)?.textContent ?? '')
    .join(' ');
}

/** Text of label[for=id] or the wrapping label (without the field's own text). */
function labelText(element: Element): string {
  const root = element.ownerDocument;
  const parts: string[] = [];
  const id = element.getAttribute('id');
  if (id !== null && id !== '') {
    for (const label of Array.from(root.querySelectorAll('label'))) {
      if (label.getAttribute('for') === id) parts.push(label.textContent ?? '');
    }
  }
  const wrapping = element.closest('label');
  if (wrapping !== null) {
    const own = element.textContent ?? '';
    const text = wrapping.textContent ?? '';
    parts.push(own !== '' ? text.replace(own, ' ') : text);
  }
  return parts.join(' ');
}

/** Accessible name: aria-label, aria-labelledby, label, alt, title, text, button value, placeholder (16 §7.5). */
function accessibleName(element: Element): string {
  const root = element.ownerDocument;
  const candidates: Array<() => string> = [
    () => element.getAttribute('aria-label') ?? '',
    () => textOfIds(root, element.getAttribute('aria-labelledby') ?? ''),
    () => (isFormField(element) ? labelText(element) : ''),
    () => element.getAttribute('alt') ?? '',
    () => element.getAttribute('title') ?? '',
    () => element.textContent ?? '',
    () => {
      if (element.tagName !== 'INPUT') return '';
      const type = (element.getAttribute('type') ?? '').toLowerCase();
      return BUTTON_TYPES.has(type) ? ((element as HTMLInputElement).value ?? '') : '';
    },
    () => element.getAttribute('placeholder') ?? '',
  ];
  for (const candidate of candidates) {
    const value = norm(candidate());
    if (value !== '') return value;
  }
  return '';
}

/** Field labels a `by: "label"` target may match: label[for]/wrapping label, aria-labelledby and aria-label. */
function fieldLabels(element: Element): string[] {
  const root = element.ownerDocument;
  return [
    norm(labelText(element)),
    norm(textOfIds(root, element.getAttribute('aria-labelledby') ?? '')),
    norm(element.getAttribute('aria-label')),
  ].filter((value) => value !== '');
}

function allElements(root: Document): Element[] {
  const body = root.body as HTMLElement | null;
  if (body === null) return [];
  return Array.from(body.querySelectorAll('*')).filter((element) => !SKIP_TAGS.has(element.tagName));
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

/** Visible elements matching the target, in document order (portals included). */
export function findStepTargets(target: StepTarget, root: Document = document): Element[] {
  let matches: Element[];
  switch (target.by) {
    case 'role': {
      const role = target.role.trim().toLowerCase();
      const name = norm(target.name);
      matches = allElements(root).filter((element) => roleOf(element) === role && accessibleName(element) === name);
      break;
    }
    case 'text': {
      const text = norm(target.text);
      const candidates = allElements(root).filter((element) => norm(element.textContent) === text);
      matches = candidates.filter(
        (element) => !Array.from(element.children).some((child) => norm(child.textContent) === text),
      );
      break;
    }
    case 'label': {
      const label = norm(target.label);
      matches = allElements(root).filter((element) => isFormField(element) && fieldLabels(element).includes(label));
      break;
    }
    case 'placeholder': {
      const placeholder = norm(target.placeholder);
      matches = allElements(root).filter(
        (element) =>
          (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') &&
          norm(element.getAttribute('placeholder')) === placeholder,
      );
      break;
    }
    case 'testId': {
      const body = root.body as HTMLElement | null;
      matches = body === null ? [] : Array.from(body.querySelectorAll(`[data-testid="${cssEscape(target.testId)}"]`));
      break;
    }
    default:
      matches = [];
  }
  return matches.filter((element) => isVisible(element));
}

/** Marks the nth match with data-prvision-step-target=<token>; returns { found, count }. Removes older marks with the same token. */
export function markStepTarget(target: StepTarget, token: string): { found: boolean; count: number } {
  for (const marked of Array.from(document.querySelectorAll(`[${MARK_ATTRIBUTE}="${cssEscape(token)}"]`))) {
    marked.removeAttribute(MARK_ATTRIBUTE);
  }
  const matches = findStepTargets(target);
  const element = matches[target.nth ?? 0];
  if (element === undefined) return { found: false, count: matches.length };
  element.setAttribute(MARK_ATTRIBUTE, token);
  return { found: true, count: matches.length };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function resolveTarget(target: StepTarget, timeoutMs: number): Promise<Element | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const element = findStepTargets(target)[target.nth ?? 0];
    if (element !== undefined) return element;
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

function focusElement(element: Element): void {
  if (typeof (element as HTMLElement).focus === 'function') (element as HTMLElement).focus();
}

function dispatchPointer(element: Element, type: string): void {
  const init = { bubbles: true, cancelable: true, composed: true, view: window };
  const event = type.startsWith('pointer') && typeof PointerEvent === 'function'
    ? new PointerEvent(type, { ...init, pointerType: 'mouse', isPrimary: true })
    : new MouseEvent(type, init);
  element.dispatchEvent(event);
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter !== undefined) {
    setter.call(element, value);
  } else {
    element.value = value;
  }
}

function keyInit(key: StepKey): KeyboardEventInit {
  const value = key === 'Space' ? ' ' : key;
  return { key: value, code: key === 'Space' ? 'Space' : key, bubbles: true, cancelable: true, composed: true };
}

function describeTarget(target: StepTarget): string {
  switch (target.by) {
    case 'role': return `${target.role} "${target.name}"`;
    case 'text': return `text "${target.text}"`;
    case 'label': return `field labelled "${target.label}"`;
    case 'placeholder': return `field with placeholder "${target.placeholder}"`;
    case 'testId': return `test id "${target.testId}"`;
    default: return 'target';
  }
}

/** Live mode only (E8): replays steps with synthetic events; hover is skipped. Never throws. */
export async function runStepsInPage(
  steps: readonly Step[],
  settle: () => Promise<void>,
  options: { timeoutMs: number },
): Promise<{ replayed: number; skipped: Array<{ index: number; action: string; reason: string }> }> {
  const skipped: Array<{ index: number; action: string; reason: string }> = [];
  let replayed = 0;
  let stopped = false;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step === undefined) continue;
    if (stopped) {
      skipped.push({ index, action: step.action, reason: 'an earlier step could not run' });
      continue;
    }
    if (step.action === 'hover') {
      skipped.push({ index, action: step.action, reason: 'hover cannot be replayed in live mode; point at the element yourself' });
      continue;
    }
    try {
      const target: StepTarget | undefined = step.target;
      let element: Element | null = null;
      if (target !== undefined) {
        element = await resolveTarget(target, options.timeoutMs);
        if (element === null) {
          skipped.push({ index, action: step.action, reason: `no visible ${describeTarget(target)} matched` });
          stopped = true;
          continue;
        }
      }
      switch (step.action) {
        case 'click':
          if (element !== null) {
            dispatchPointer(element, 'pointerdown');
            dispatchPointer(element, 'mousedown');
            focusElement(element);
            dispatchPointer(element, 'pointerup');
            dispatchPointer(element, 'mouseup');
            if (typeof (element as HTMLElement).click === 'function') (element as HTMLElement).click();
          }
          break;
        case 'focus':
          if (element !== null) focusElement(element);
          break;
        case 'type':
          if (element !== null) {
            focusElement(element);
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              let value = element.value;
              for (const character of Array.from(step.text)) {
                value += character;
                setNativeValue(element, value);
                element.dispatchEvent(new Event('input', { bubbles: true }));
              }
              element.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
              skipped.push({ index, action: step.action, reason: 'the target is not a text field' });
              continue;
            }
          }
          break;
        case 'press': {
          if (element !== null) focusElement(element);
          const focused = document.activeElement ?? document.body;
          let changed = false;
          const observer = new MutationObserver(() => {
            changed = true;
          });
          observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
          focused.dispatchEvent(new KeyboardEvent('keydown', keyInit(step.key)));
          focused.dispatchEvent(new KeyboardEvent('keyup', keyInit(step.key)));
          await sleep(0);
          observer.disconnect();
          if (!changed && document.activeElement === focused) {
            skipped.push({ index, action: step.action, reason: `pressing ${step.key} changed nothing (synthetic keys have no default action)` });
            continue;
          }
          break;
        }
        case 'waitFor':
          break;
      }
      replayed += 1;
    } catch (error) {
      skipped.push({ index, action: step.action, reason: error instanceof Error ? error.message : String(error) });
      stopped = true;
    }
  }
  if (steps.length > 0) {
    try {
      await settle();
    } catch {
      // Settling is best effort in live mode.
    }
  }
  return { replayed, skipped };
}

/** Installs window.__PRVISION_MARK_STEP_TARGET__ = markStepTarget. */
export function installStepBridge(): void {
  window.__PRVISION_MARK_STEP_TARGET__ = markStepTarget;
}

/**
 * Selector matching for template usage (sheet 15 §5.5.2 step 5): one `SelectorMatcher` from PRVision's pinned
 * `@angular/compiler` over every component and directive selector of a side. Scanned template elements are matched
 * exactly as the Angular compiler matches them (element, classes, attribute/input/output names, `:not()`).
 */
import { CssSelector, SelectorMatcher } from "@angular/compiler";
import type { AngularTemplateElementScan, AngularTemplateScan } from "./angular-template-scanner";

export interface AngularSelectable {
  key: string; // ComponentKey / DirectiveKey: "<repo-relative path>#<className>"
  selector: string;
}

/** Matches scanned template elements against component and directive selectors. */
export class AngularSelectorMatcher {
  private readonly matcher = new SelectorMatcher<string>();
  private readonly invalid: string[] = [];

  /**
   * @param selectables - Every component/directive with a static selector. Unparsable selectors are skipped and
   *   listed in `invalidSelectors`.
   */
  constructor(selectables: readonly AngularSelectable[]) {
    for (const selectable of selectables) {
      try {
        this.matcher.addSelectables(CssSelector.parse(selectable.selector), selectable.key);
      } catch {
        this.invalid.push(selectable.key);
      }
    }
  }

  /** Keys whose selector could not be parsed. */
  get invalidSelectors(): readonly string[] {
    return this.invalid;
  }

  /** Keys matched by one element. */
  matchElement(element: AngularTemplateElementScan): string[] {
    const selector = new CssSelector();
    if (element.element !== null) {
      selector.setElement(element.element);
    }
    for (const className of element.classNames) {
      selector.addClassName(className);
    }
    for (let index = 0; index + 1 < element.attrs.length; index += 2) {
      selector.addAttribute(element.attrs[index] ?? "", element.attrs[index + 1] ?? "");
    }
    const found = new Set<string>();
    this.matcher.match(selector, (_selector, key) => {
      found.add(key);
    });
    return [...found].sort();
  }

  /** Keys matched anywhere in a template scan, with the first matching line of each. */
  matchUsages(scan: AngularTemplateScan): Map<string, number> {
    const out = new Map<string, number>();
    for (const element of scan.elements) {
      for (const key of this.matchElement(element)) {
        if (!out.has(key)) {
          out.set(key, element.line);
        }
      }
    }
    return out;
  }
}

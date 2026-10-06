/**
 * Angular analysis contract (sheet 15 §5.2.2, verbatim). Owned by 15b; imported by 15c (harness generation) and
 * 15e (structural diff). `AngularSourceQueries` (15b) implements `AngularSourceQueriesLike`.
 */
import type { CallSite, ComponentSourceQueries, WorktreeSide } from "./visualization-pipeline";

export interface AngularInputMeta {
  name: string; // class property name
  alias: string | null; // public name when aliased (setInput uses alias ?? name)
  kind: "decorator" | "signal" | "model" | "metadata"; // @Input | input() | model() | @Component({ inputs })
  required: boolean; // input.required(), @Input({ required: true }), model.required()
  typeText: string | null; // declared or generic type text, e.g. "Notification", "string | null"
  initializerText: string | null; // default value source, e.g. "true", "0"
  hasTransform: boolean;
}

export interface AngularOutputMeta {
  name: string;
  alias: string | null;
  kind: "decorator" | "signal" | "model" | "metadata";
}

export interface AngularInjectedDependency {
  token: string; // source text of the token: "NotificationService", "API_AUTH_BRIDGE"
  via: "constructor" | "inject";
  optional: boolean; // @Optional() or inject(X, { optional: true })
  importSpecifier: string | null; // specifier the token is imported from in the component file
  resolvedPath: string | null; // repo-relative file of the token, or "package:<name>", or null
  providedIn: "root" | "platform" | "any" | null; // from @Injectable on resolvedPath (repo files only)
  hints: string[]; // e.g. "constructor starts a timer", "constructor calls HTTP"; see 15b §5.5.4
}

export interface AngularTemplateRef {
  kind: "inline" | "external";
  path: string | null; // repo-relative for external
  text: string; // template source (inline: the literal's text, unescaped)
  startLine: number; // 1-based line in `path` (external) or in the component file (inline)
}

export interface AngularStyleRef {
  kind: "inline" | "external";
  path: string | null;
  language: "css" | "scss" | "sass" | "less";
}

export interface AngularComponentMeta {
  filePath: string; // repo-relative TS file
  className: string;
  exportName: string; // className, or "default" for `export default class`
  selector: string | null;
  standalone: boolean; // false only for `standalone: false` (Angular ≥19 default true) or, for <19, absent flag
  declaringModule: { filePath: string; className: string } | null; // NgModule that declares it (standalone: false)
  template: AngularTemplateRef | null;
  styles: AngularStyleRef[];
  inputs: AngularInputMeta[];
  outputs: AngularOutputMeta[];
  injected: AngularInjectedDependency[];
  imports: string[]; // identifiers listed in @Component({ imports })
  changeDetection: "OnPush" | "Default" | null;
}

export interface AngularInjectableOutline {
  filePath: string;
  className: string;
  providedIn: "root" | "platform" | "any" | null;
  /** Class with method bodies replaced by `{ … }`, private members dropped, ≤ 120 lines. */
  outline: string;
  constructorHints: string[];
}

export interface AngularAppProvider {
  text: string; // provider expression source, e.g. "{ provide: API_AUTH_BRIDGE, useExisting: AuthService }"
  token: string | null; // "API_AUTH_BRIDGE", "APP_INITIALIZER", null for provideX() calls
  source: string; // repo-relative file (main.ts or app.config.ts)
}

export interface AngularComponentQueries {
  readonly framework: "angular";
  getComponentMeta(filePath: string, exportName: string, side: WorktreeSide): Promise<AngularComponentMeta | null>;
  getInjectableOutline(
    filePath: string,
    className: string,
    side: WorktreeSide
  ): Promise<AngularInjectableOutline | null>;
  /** Providers passed to bootstrapApplication (main.ts) or exported app configs (app.config.ts); [] when none. */
  getAppProviders(side: WorktreeSide): Promise<AngularAppProvider[]>;
  /** *.spec.ts files that configure TestBed for this component; snippet = the TestBed.configureTestingModule call. */
  findSpecSetups(filePath: string, exportName: string, side: WorktreeSide, limit: number): Promise<CallSite[]>;
}

export type AngularSourceQueriesLike = ComponentSourceQueries & AngularComponentQueries;

export function isAngularSourceQueries(q: ComponentSourceQueries): q is AngularSourceQueriesLike {
  return (q as Partial<AngularComponentQueries>).framework === "angular";
}

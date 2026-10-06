/**
 * In-memory AngularSourceQueries (15 §5.2.2) for 15c tests: 09's FakeSourceQueries (resolution, imports, types,
 * call sites, changed dependencies) plus the Angular queries, answered from per-side tables. Every call is recorded.
 */
import type {
  AngularAppProvider,
  AngularComponentMeta,
  AngularComponentQueries,
  AngularInjectableOutline,
  AngularInputMeta
} from "../../../../backend/src/types/angular-analysis";
import type { CallSite, WorktreeSide } from "../../../../backend/src/types/visualization-pipeline";
import { FakeSourceQueries, type FakeSourceQueriesOptions } from "./fake-source-queries";

type PerSide<T> = Record<WorktreeSide, T>;

export interface FakeAngularSourceQueriesOptions extends FakeSourceQueriesOptions {
  /** Component metadata keyed `${side}:${filePath}`. */
  metas?: Record<string, AngularComponentMeta>;
  /** Injectable outlines keyed `${side}:${filePath}#${className}`. */
  outlines?: Record<string, AngularInjectableOutline>;
  appProviders?: Partial<PerSide<AngularAppProvider[]>>;
  /** Spec setups keyed `${side}:${filePath}`. */
  specSetups?: Record<string, CallSite[]>;
}

export const ANGULAR_PACKAGES = ["@angular/core", "@angular/common", "@angular/router", "rxjs", "zone.js"];

/** An Angular input with defaults (decorator, optional, untyped). */
export function angularInput(overrides: Partial<AngularInputMeta> & Pick<AngularInputMeta, "name">): AngularInputMeta {
  return {
    alias: null,
    kind: "decorator",
    required: false,
    typeText: null,
    initializerText: null,
    hasTransform: false,
    ...overrides
  };
}

/** Component metadata with defaults (standalone, no template, no inputs). */
export function angularMeta(
  overrides: Partial<AngularComponentMeta> & Pick<AngularComponentMeta, "filePath" | "className">
): AngularComponentMeta {
  return {
    exportName: overrides.className,
    selector: null,
    standalone: true,
    declaringModule: null,
    template: null,
    styles: [],
    inputs: [],
    outputs: [],
    injected: [],
    imports: [],
    changeDetection: null,
    ...overrides
  };
}

export class FakeAngularSourceQueries extends FakeSourceQueries implements AngularComponentQueries {
  readonly framework = "angular" as const;
  readonly angularCalls: Array<{ method: keyof AngularComponentQueries; args: unknown[] }> = [];

  constructor(private readonly angular: FakeAngularSourceQueriesOptions = {}) {
    super({ packages: { base: ANGULAR_PACKAGES, head: ANGULAR_PACKAGES }, aliases: {}, ...angular });
  }

  /** Sets the metadata of a component on one or both sides. */
  setMeta(side: WorktreeSide | "both", meta: AngularComponentMeta): void {
    this.angular.metas ??= {};
    for (const target of side === "both" ? (["base", "head"] as const) : [side]) {
      this.angular.metas[`${target}:${meta.filePath}`] = meta;
    }
  }

  getComponentMeta(filePath: string, exportName: string, side: WorktreeSide): Promise<AngularComponentMeta | null> {
    this.angularCalls.push({ method: "getComponentMeta", args: [filePath, exportName, side] });
    return Promise.resolve(this.angular.metas?.[`${side}:${filePath}`] ?? null);
  }

  getInjectableOutline(
    filePath: string,
    className: string,
    side: WorktreeSide
  ): Promise<AngularInjectableOutline | null> {
    this.angularCalls.push({ method: "getInjectableOutline", args: [filePath, className, side] });
    return Promise.resolve(this.angular.outlines?.[`${side}:${filePath}#${className}`] ?? null);
  }

  getAppProviders(side: WorktreeSide): Promise<AngularAppProvider[]> {
    this.angularCalls.push({ method: "getAppProviders", args: [side] });
    return Promise.resolve(this.angular.appProviders?.[side] ?? []);
  }

  findSpecSetups(filePath: string, exportName: string, side: WorktreeSide, limit: number): Promise<CallSite[]> {
    this.angularCalls.push({ method: "findSpecSetups", args: [filePath, exportName, side, limit] });
    return Promise.resolve((this.angular.specSetups?.[`${side}:${filePath}`] ?? []).slice(0, limit));
  }
}

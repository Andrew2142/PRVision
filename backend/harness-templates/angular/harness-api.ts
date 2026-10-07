/*
 * PRVision Angular harness API (static template, sheets 15d and 16b).
 * AI-written harness modules import ONLY definePrvisionHarness/types from this file plus application code.
 */
import type { EnvironmentProviders, Provider, Type } from '@angular/core';

/** One canned HTTP response. The first matching fixture wins; unmatched requests get a 404 HttpErrorResponse. */
export interface PrvisionHttpFixture {
  method?: string;                 // default: any method
  url: string | RegExp;            // string = substring of the full request URL (with params)
  status?: number;                 // default 200; >= 400 → HttpErrorResponse with `body` as `error`
  body?: unknown;
  headers?: Record<string, string>;
}

export type PrvisionStepTarget =
  | { by: 'role'; role: string; name: string; nth?: number }
  | { by: 'text'; text: string; nth?: number }
  | { by: 'label'; label: string; nth?: number }
  | { by: 'placeholder'; placeholder: string; nth?: number }
  | { by: 'testId'; testId: string; nth?: number };

export type PrvisionStepKey =
  | 'Enter' | 'Escape' | 'Tab' | 'Space' | 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

export type PrvisionStep =
  | { action: 'click'; target: PrvisionStepTarget }
  | { action: 'hover'; target: PrvisionStepTarget }
  | { action: 'focus'; target: PrvisionStepTarget }
  | { action: 'type'; target: PrvisionStepTarget; text: string }
  | { action: 'press'; key: PrvisionStepKey; target?: PrvisionStepTarget }
  | { action: 'waitFor'; target: PrvisionStepTarget };

/** One additional state. Default is the top-level descriptor and never appears here. */
export interface PrvisionAngularState {
  name: string;
  /** Shallow-merged over the top-level inputs (a key here replaces the top-level value). */
  inputs?: Record<string, unknown>;
  /** Appended after the top-level providers (a later provider for the same token wins). */
  providers?: Array<Provider | EnvironmentProviders>;
  /** Checked before the top-level fixtures (first match wins). */
  http?: PrvisionHttpFixture[];
  steps?: PrvisionStep[];
}

export interface PrvisionAngularHarness<T = unknown> {
  /** The component under test (exact import from <target>), or a standalone host component declared in the harness. */
  component: Type<T>;
  /** Set with ComponentRef.setInput (decorator and signal inputs). Keys are public input names. */
  inputs?: Record<string, unknown>;
  /** Application-level providers: DI fakes, tokens, importProvidersFrom(SomeNgModule). */
  providers?: Array<Provider | EnvironmentProviders>;
  /** Canned HTTP responses served by PRVision's HttpBackend. */
  http?: PrvisionHttpFixture[];
  /** Inline CSS for the wrapper element the component is mounted into. */
  hostStyle?: Record<string, string>;
  /** Runs before bootstrapApplication: document attributes, storage seeds. */
  setup?: () => void | Promise<void>;
  /** Additional states (Default = the fields above). component, hostStyle and setup are shared. */
  states?: PrvisionAngularState[];
}

export function definePrvisionHarness<T>(harness: PrvisionAngularHarness<T>): PrvisionAngularHarness<T> {
  return harness;
}

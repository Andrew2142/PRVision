/**
 * Pure mock rules shared by sheets 08, 09 and 10 (10 §5.8.1–5.8.2, 00 §14.12). Imports only `node:path` and the
 * `MockedModule` type. Sheet 10 consumes it and may not change its rules without updating 09's validator.
 */
import path from "node:path";

import type { MockedModule } from "../../../types/visualization-pipeline";

export const STYLE_OR_ASSET_EXTENSIONS: readonly string[] = [
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".stylus",
  ".pcss",
  ".postcss",
  ".sss",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".json",
  ".wasm"
];
export const MOCK_SOURCE_MAX_CHARS = 200_000;

export function isUnmockableSpecifier(specifier: string): boolean {
  return (
    specifier === "react" ||
    specifier === "react-dom" ||
    specifier === "scheduler" ||
    specifier.startsWith("react/") ||
    specifier.startsWith("react-dom/")
  );
}

export type SpecifierKind = "relative" | "absolute" | "bare";

/** "relative": ".", "..", "./*", "../*"; "absolute": "/*" (Vite root-relative); otherwise "bare". */
export function classifySpecifier(specifier: string): SpecifierKind {
  if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) {
    return "relative";
  }
  if (specifier.startsWith("/")) {
    return "absolute";
  }
  return "bare";
}

/** "@scope/name/sub" → "@scope/name"; "name/sub" → "name"; null for "", relative/absolute, "@/…", "~/…", "#…", or anything containing ":". */
export function packageNameOf(specifier: string): string | null {
  if (specifier === "" || specifier.includes(":")) {
    return null;
  }
  if (classifySpecifier(specifier) !== "bare") {
    return null;
  }
  if (specifier.startsWith("@/") || specifier.startsWith("~/") || specifier.startsWith("#")) {
    return null;
  }
  if (specifier === "@" || specifier === "~") {
    return null;
  }
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    const scope = parts[0];
    const name = parts[1];
    if (scope === undefined || name === undefined || scope.length < 2 || name === "") {
      return null;
    }
    return `${scope}/${name}`;
  }
  const name = parts[0];
  return name === undefined || name === "" ? null : name;
}

export interface MockValidationResult {
  accepted: MockedModule[];
  rejected: Array<{ specifier: string; reason: string; duplicate: boolean }>;
}

function withoutQueryOrHash(specifier: string): string {
  const cut = specifier.search(/[?#]/);
  return cut === -1 ? specifier : specifier.slice(0, cut);
}

function hasStyleOrAssetExtension(specifier: string): boolean {
  const ext = path.posix.extname(withoutQueryOrHash(specifier)).toLowerCase();
  return ext !== "" && STYLE_OR_ASSET_EXTENSIONS.includes(ext);
}

/** Pure, syntactic, order-preserving. Reasons (exact text, used in console warnings and 09 issue messages):
 *  "empty specifier" | "specifier contains whitespace" | "specifiers with a query cannot be mocked" |
 *  "stylesheets and assets cannot be mocked" | "React core cannot be mocked" | "duplicate specifier (first one kept)" |
 *  "empty source" | "source is longer than 200000 characters". Extension check uses the specifier without its query/hash, lower-cased. */
export function validateMockedModules(mocks: readonly MockedModule[]): MockValidationResult {
  const accepted: MockedModule[] = [];
  const rejected: MockValidationResult["rejected"] = [];
  const seen = new Set<string>();
  for (const mock of mocks) {
    const { specifier, source } = mock;
    const reject = (reason: string, duplicate = false): void => {
      rejected.push({ specifier, reason, duplicate });
    };
    if (specifier.trim() === "") {
      reject("empty specifier");
    } else if (/\s/.test(specifier)) {
      reject("specifier contains whitespace");
    } else if (specifier.includes("?")) {
      reject("specifiers with a query cannot be mocked");
    } else if (hasStyleOrAssetExtension(specifier)) {
      reject("stylesheets and assets cannot be mocked");
    } else if (isUnmockableSpecifier(specifier)) {
      reject("React core cannot be mocked");
    } else if (seen.has(specifier)) {
      reject("duplicate specifier (first one kept)", true);
    } else if (source.trim() === "") {
      reject("empty source");
    } else if (source.length > MOCK_SOURCE_MAX_CHARS) {
      reject(`source is longer than ${String(MOCK_SOURCE_MAX_CHARS)} characters`);
    } else {
      seen.add(specifier);
      accepted.push(mock);
    }
  }
  return { accepted, rejected };
}

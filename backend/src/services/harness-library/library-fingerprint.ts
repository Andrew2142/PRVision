/**
 * Component fingerprints (16 §8.1, D2): a sha256 over the normalized source of a component when its harness was
 * written. It never triggers regeneration; it only tells the reviewer that the component changed since and goes
 * into export files. Normalization is 08's (React closures) and 15b's (Angular class text and template
 * fingerprint), so formatting-only edits keep the fingerprint.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";
import type { LibraryComponentIdentity } from "../../types/harness-library";
import { AngularDecoratorReader } from "../visualizations/pipeline/angular/angular-decorator-reader";
import { AngularTemplateScanner } from "../visualizations/pipeline/angular/angular-template-scanner";
import { ComponentDetector, normalizeSource } from "../visualizations/pipeline/component-detector";
import { isCoLocatedStyle } from "../visualizations/pipeline/import-graph";

const posix = path.posix;
const FINGERPRINT_VERSION = "prvision-fp-v1";
const STYLE_SPECIFIER = /\.(css|scss|sass|less|styl)(\?.*)?$/;

export interface FingerprintInput {
  framework: "react_vite" | "angular";
  identity: LibraryComponentIdentity;
  /** Reads a repo-relative file of the side being fingerprinted; null when missing. */
  readFile(repoRelativePath: string): Promise<string | null>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Stylesheet text with `/* … *\/` comments removed and whitespace runs collapsed (16 §8.1). */
export function normalizeCss(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The hashed text of 16 §8.1. */
export function fingerprintText(
  framework: "react_vite" | "angular",
  identity: LibraryComponentIdentity,
  parts: readonly string[]
): string {
  return `${FINGERPRINT_VERSION}\n${framework}\n${identity.filePath}\n${identity.exportName}\n${parts.join("\n")}`;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return null;
  }
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), specifier.replace(/\?.*$/, "")));
  return joined.startsWith("../") || joined === ".." ? null : joined;
}

/** Computes component fingerprints (16 §8.1). Stateless apart from its parsers. */
export class LibraryFingerprinter {
  private readonly detector: ComponentDetector;
  private readonly reader = new AngularDecoratorReader();
  private readonly scanner = new AngularTemplateScanner();

  constructor(deps: { detector?: ComponentDetector } = {}) {
    this.detector = deps.detector ?? new ComponentDetector();
  }

  /**
   * The fingerprint of one component on one side.
   *
   * @returns 64 hex chars, or null when the component cannot be located in the file.
   */
  async fingerprint(input: FingerprintInput): Promise<string | null> {
    const parts = input.framework === "angular" ? await this.angularParts(input) : await this.reactParts(input);
    return parts === null ? null : sha256(fingerprintText(input.framework, input.identity, parts));
  }

  private async reactParts(input: FingerprintInput): Promise<string[] | null> {
    const { filePath, exportName } = input.identity;
    const text = await input.readFile(filePath);
    if (text === null) {
      return null;
    }
    const sf = this.detector.parse(filePath, text);
    const closure = this.detector.normalizedClosure(sf, exportName);
    if (closure === null) {
      return null;
    }
    const parts = [`component:${sha256(closure)}`];
    const styles = new Set<string>();
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      if (!STYLE_SPECIFIER.test(specifier)) {
        continue;
      }
      const stylePath = resolveRelative(filePath, specifier);
      if (stylePath !== null && isCoLocatedStyle(stylePath, filePath)) {
        styles.add(stylePath);
      }
    }
    for (const stylePath of [...styles].sort()) {
      parts.push(await this.stylePart(input, stylePath));
    }
    return parts;
  }

  private async angularParts(input: FingerprintInput): Promise<string[] | null> {
    const { filePath, exportName } = input.identity;
    const text = await input.readFile(filePath);
    if (text === null) {
      return null;
    }
    const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const classes = this.reader.read(sf).filter((cls) => cls.kind === "Component");
    const cls =
      classes.find((candidate) => candidate.exportName === exportName) ??
      classes.find((candidate) => candidate.className === exportName);
    if (cls === undefined) {
      return null;
    }
    const parts = [`component:${sha256(normalizeSource(text.slice(cls.start, cls.end), filePath))}`];
    let template: { text: string; url: string } | null = null;
    if (cls.inlineTemplate !== null) {
      template = { text: cls.inlineTemplate.text, url: filePath };
    } else if (cls.templateUrl !== null) {
      const templatePath = resolveRelative(
        filePath,
        cls.templateUrl.startsWith(".") ? cls.templateUrl : `./${cls.templateUrl}`
      );
      const templateText = templatePath === null ? null : await input.readFile(templatePath);
      template = templatePath === null || templateText === null ? null : { text: templateText, url: templatePath };
      if (template === null) {
        parts.push("template:missing");
      }
    }
    if (template !== null) {
      parts.push(`template:${sha256(this.scanner.scan(template.text, template.url).fingerprint)}`);
    }
    const styles = cls.styleUrls
      .map((url) => resolveRelative(filePath, url.startsWith(".") ? url : `./${url}`))
      .filter((stylePath): stylePath is string => stylePath !== null);
    for (const stylePath of [...new Set(styles)].sort()) {
      parts.push(await this.stylePart(input, stylePath));
    }
    return parts;
  }

  private async stylePart(input: FingerprintInput, stylePath: string): Promise<string> {
    const css = await input.readFile(stylePath);
    return css === null ? `style:${stylePath}:missing` : `style:${stylePath}:${sha256(normalizeCss(css))}`;
  }
}

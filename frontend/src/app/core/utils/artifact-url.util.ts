import { environment } from '../../../environments/environment';

/** Where `/artifacts/…` lives; the backend by default, a report's own folder in the report viewer. */
let artifactBaseUrl: string = environment.artifactBaseUrl;

/** The report viewer serves screenshots from the report's folder instead of the backend. */
export function setArtifactBaseUrl(base: string): void {
  artifactBaseUrl = base;
}

/**
 * The only place an image URL is built (01 §5.14.3): `/artifacts/…` from the API → absolute URL on the backend.
 * Returns null for anything that is not a plain `/artifacts/` path (no `..`, `\`, `?`, `#` or `//`).
 */
export function artifactUrl(path: string | null | undefined): string | null {
  if (!path?.startsWith('/artifacts/') || /(^|\/)\.\.(\/|$)|\\|[?#]|\/\//.test(path)) return null;
  return `${artifactBaseUrl.replace(/\/+$/, '')}${path}`;
}

import { environment } from '../../../environments/environment';

/**
 * The only place an image URL is built (01 §5.14.3): `/artifacts/…` from the API → absolute URL on the backend.
 * Returns null for anything that is not a plain `/artifacts/` path (no `..`, `\`, `?`, `#` or `//`).
 */
export function artifactUrl(path: string | null | undefined): string | null {
  if (!path?.startsWith('/artifacts/') || /(^|\/)\.\.(\/|$)|\\|[?#]|\/\//.test(path)) return null;
  return `${environment.artifactBaseUrl.replace(/\/+$/, '')}${path}`;
}

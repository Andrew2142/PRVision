/**
 * Dynamic import of the target repo's Vite entry (a file:// URL), 10 §5.5.1.
 *
 * The backend compiles with `module: nodenext` (01 §2): TypeScript keeps `import()` as a native dynamic import
 * in CommonJS output (it is NOT rewritten to require()), so ESM-only Vite 7 loads correctly. ts-node (dev, tests)
 * uses the same tsconfig. No `new Function`/eval trick is needed or allowed (no-implied-eval, CSP-style hygiene).
 * `require(esm)` is not used here because the URL is computed at runtime and Vite's entry may use top-level await.
 *
 * PURE: loaded by the Vite host child process.
 *
 * @param fileUrl - `file://` URL of the module to import.
 * @returns The module namespace object.
 */
export async function esmImport(fileUrl: string): Promise<unknown> {
  return import(fileUrl);
}

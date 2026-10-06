/**
 * The harness plugin (10 §5.9): serves `virtual:prvision-mount`, the React-version-specific mount function the
 * harness entry imports. PURE: runs inside the Vite host child.
 */
import type { VitePluginLike } from "./render-types";

export const MOUNT_PUBLIC_ID = "virtual:prvision-mount";
export const MOUNT_RESOLVED_ID = "\0prvision-mount";

/** Mount module source: `createRoot` for React 18+, legacy `ReactDOM.render` for React 16.8–17. */
export function buildMountModuleSource(reactDomMajor: number): string {
  if (reactDomMajor >= 18) {
    return [
      'import { createRoot } from "react-dom/client";',
      "export function mount(container, element) {",
      "  const root = createRoot(container);",
      "  root.render(element);",
      "  return () => root.unmount();",
      "}",
      ""
    ].join("\n");
  }
  return [
    'import ReactDOM from "react-dom";',
    "export function mount(container, element) {",
    "  ReactDOM.render(element, container);",
    "  return () => ReactDOM.unmountComponentAtNode(container);",
    "}",
    ""
  ].join("\n");
}

/** Creates the `prvision:harness` plugin. */
export function createHarnessPlugin(options: { reactDomMajor: number }): VitePluginLike {
  return {
    name: "prvision:harness",
    enforce: "pre",
    resolveId(source: string): string | null {
      return source === MOUNT_PUBLIC_ID ? MOUNT_RESOLVED_ID : null;
    },
    load(id: string): { code: string; map: null } | null {
      return id === MOUNT_RESOLVED_ID ? { code: buildMountModuleSource(options.reactDomMajor), map: null } : null;
    }
  };
}

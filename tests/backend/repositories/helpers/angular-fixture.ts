/**
 * Angular workspace file sets for 15a tests (app discovery and Angular detection). Files are plain text; nothing is
 * installed for real: `installedPackages` writes node_modules/<pkg>/package.json stubs (git-ignored by the temp repo).
 */
import type { FileMap } from "../../helpers/temp-git-repo";

export interface AngularProjectSpec {
  name: string;
  projectType?: "application" | "library";
  builder?: string | null;
  options?: Record<string, unknown>;
  configurations?: Record<string, Record<string, unknown>>;
  /** Use the Nx-style `targets` key instead of `architect`. */
  useTargets?: boolean;
}

/** Default build options of an Angular 17+ application (paths relative to the workspace folder). */
export const DEFAULT_BUILD_OPTIONS: Record<string, unknown> = {
  outputPath: "dist/app",
  index: "src/index.html",
  browser: "src/main.ts",
  polyfills: ["zone.js"],
  tsConfig: "tsconfig.app.json",
  styles: ["src/styles.css"]
};

/** angular.json text for the given projects. */
export function angularJson(projects: AngularProjectSpec[]): string {
  const entries: Record<string, unknown> = {};
  for (const project of projects) {
    const build =
      project.builder === null
        ? undefined
        : {
            builder: project.builder ?? "@angular/build:application",
            options: project.options ?? DEFAULT_BUILD_OPTIONS,
            configurations: project.configurations ?? { production: {}, development: { optimization: false } }
          };
    entries[project.name] = {
      projectType: project.projectType ?? "application",
      root: "",
      sourceRoot: "src",
      [project.useTargets ? "targets" : "architect"]: build === undefined ? {} : { build }
    };
  }
  return `${JSON.stringify({ version: 1, projects: entries }, null, 2)}\n`;
}

/** package.json of an Angular app folder. */
export function angularPackageJson(name: string, extraDeps: Record<string, string> = {}): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      dependencies: { "@angular/core": "^21.2.0", "zone.js": "~0.15.0", ...extraDeps },
      devDependencies: { "@angular/build": "^21.2.0", "@angular/cli": "^21.2.0" }
    },
    null,
    2
  )}\n`;
}

/** The tracked files of one Angular workspace in `appRoot` ("." = repository root). */
export function angularAppFiles(
  appRoot: string,
  options: { name?: string; projects?: AngularProjectSpec[]; extra?: FileMap } = {}
): FileMap {
  const name = options.name ?? (appRoot === "." ? "angular-app" : (appRoot.split("/").at(-1) ?? "angular-app"));
  const prefix = appRoot === "." ? "" : `${appRoot}/`;
  const files: FileMap = {
    [`${prefix}angular.json`]: angularJson(options.projects ?? [{ name }]),
    [`${prefix}package.json`]: angularPackageJson(name),
    [`${prefix}package-lock.json`]: '{\n  "lockfileVersion": 3\n}\n',
    [`${prefix}tsconfig.app.json`]: "{}\n",
    [`${prefix}src/main.ts`]: "export {};\n",
    [`${prefix}src/styles.css`]: "body { margin: 0; }\n"
  };
  for (const [relative, content] of Object.entries(options.extra ?? {})) {
    files[`${prefix}${relative}`] = content;
  }
  return files;
}

/** node_modules/<pkg>/package.json stubs below `nodeModulesRel` (e.g. "src/app/node_modules"). */
export function installedPackages(nodeModulesRel: string, versions: Record<string, string>): FileMap {
  const files: FileMap = {};
  for (const [name, version] of Object.entries(versions)) {
    files[`${nodeModulesRel}/${name}/package.json`] = JSON.stringify({ name, version });
  }
  return files;
}

/** What a working Angular 21 install with the application builder needs. */
export const ANGULAR_21_INSTALL: Record<string, string> = {
  "@angular/core": "21.2.21",
  "@angular/build": "21.2.0",
  "@angular-devkit/architect": "0.2102.0"
};

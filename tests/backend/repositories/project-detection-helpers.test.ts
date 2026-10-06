import assert from "node:assert/strict";
import test from "node:test";
import {
  detectPackageManager,
  extractGlobalStyleImports,
  findModuleScriptSrc
} from "../../../backend/src/services/repositories/project-detection-service";
import { parseGithubRemoteUrl } from "../../../backend/src/utilities/services/github-client";

test("parseGithubRemoteUrl parses all supported forms", () => {
  const rows: Array<[string, { owner: string; repo: string }]> = [
    ["git@github.com:acme/web-app.git", { owner: "acme", repo: "web-app" }],
    ["git@github.com:acme/web-app", { owner: "acme", repo: "web-app" }],
    ["github.com:acme/web-app.git", { owner: "acme", repo: "web-app" }],
    ["ssh://git@github.com/acme/web-app.git", { owner: "acme", repo: "web-app" }],
    ["ssh://git@github.com:22/acme/web-app.git", { owner: "acme", repo: "web-app" }],
    ["ssh://git@ssh.github.com:443/acme/web-app.git", { owner: "acme", repo: "web-app" }],
    ["https://github.com/acme/web-app.git", { owner: "acme", repo: "web-app" }],
    ["https://github.com/acme/web-app/", { owner: "acme", repo: "web-app" }],
    ["https://user:ghp_secret@github.com/acme/web-app.git", { owner: "acme", repo: "web-app" }],
    ["https://www.github.com/acme/web-app", { owner: "acme", repo: "web-app" }],
    ["git://github.com/acme/web-app.git", { owner: "acme", repo: "web-app" }],
    ["HTTPS://GitHub.COM/Acme/Web-App.git", { owner: "Acme", repo: "Web-App" }],
    ["  https://github.com/acme/web.app.v2.git\n", { owner: "acme", repo: "web.app.v2" }]
  ];
  for (const [input, expected] of rows) {
    assert.deepEqual(parseGithubRemoteUrl(input), expected, input);
  }
  const withCredentials = parseGithubRemoteUrl("https://user:ghp_secret@github.com/acme/web-app.git");
  assert.ok(!JSON.stringify(withCredentials).includes("ghp_secret"), "credentials are discarded");
});

test("parseGithubRemoteUrl rejects GHES, aliases, non-GitHub hosts and malformed paths", () => {
  const rejected = [
    "https://github.example.com/acme/web-app.git",
    "git@github-work:acme/web-app.git",
    "https://gitlab.com/acme/web-app.git",
    "https://github.com/acme",
    "https://github.com/acme/web-app/tree/main",
    "/srv/git/web-app.git",
    "file:///srv/git/web-app.git",
    "ftp://github.com/acme/web-app.git",
    "https://github.com/-acme/web-app",
    "https://github.com/acme/..",
    "https://github.com/acme/.",
    "",
    "not a url"
  ];
  for (const input of rejected) {
    assert.equal(parseGithubRemoteUrl(input), null, input);
  }
});

test("findModuleScriptSrc picks the first type=module script regardless of attribute order and quotes", () => {
  assert.equal(findModuleScriptSrc('<script type="module" src="/src/main.tsx"></script>'), "/src/main.tsx");
  assert.equal(findModuleScriptSrc("<script src='/src/main.jsx' type='module'></script>"), "/src/main.jsx");
  assert.equal(findModuleScriptSrc("<SCRIPT SRC=src/entry.ts TYPE=MODULE></SCRIPT>"), "src/entry.ts");
  const html = [
    '<script src="/legacy.js"></script>',
    '<script type="text/javascript" src="/other.js"></script>',
    '<script type="module">console.log(1)</script>',
    '<script defer type="module" src="./src/first.tsx"></script>',
    '<script type="module" src="/src/second.tsx"></script>'
  ].join("\n");
  assert.equal(findModuleScriptSrc(html), "./src/first.tsx");
  assert.equal(findModuleScriptSrc("<html><body>no scripts</body></html>"), null);
});

test("findModuleScriptSrc ignores commented-out scripts and absolute URLs", () => {
  const html = [
    '<!-- <script type="module" src="/src/old.tsx"></script> -->',
    '<script type="module" src="https://cdn.example.com/x.js"></script>',
    '<script type="module" src="//cdn.example.com/y.js"></script>',
    '<script type="module" src=""></script>',
    '<script type="module" src="/src/main.tsx"></script>'
  ].join("\n");
  assert.equal(findModuleScriptSrc(html), "/src/main.tsx");
  assert.equal(findModuleScriptSrc('<script type="module" src="data:text/javascript,1"></script>'), null);
});

const exists =
  (...files: string[]) =>
  (repoRelativePath: string): boolean =>
    files.includes(repoRelativePath);

test("extractGlobalStyleImports returns root-relative paths for relative css/scss imports", () => {
  const source = [
    'import "./index.css";',
    'import "./styles/theme.scss";',
    'import "../global.less";',
    'import "/src/reset.sass";',
    'import App from "./App";'
  ].join("\n");
  const fileExists = exists("src/index.css", "src/styles/theme.scss", "global.less", "src/reset.sass");
  assert.deepEqual(extractGlobalStyleImports(source, "src/main.tsx", fileExists), [
    "/src/index.css",
    "/src/styles/theme.scss",
    "/global.less",
    "/src/reset.sass"
  ]);
});

test("extractGlobalStyleImports keeps bare package stylesheet specifiers", () => {
  const source = [
    'import "bootstrap/dist/css/bootstrap.min.css";',
    'import "@fontsource/inter";',
    'import "@fontsource-variable/inter";',
    'import "react";'
  ].join("\n");
  assert.deepEqual(extractGlobalStyleImports(source, "src/main.tsx", exists()), [
    "bootstrap/dist/css/bootstrap.min.css",
    "@fontsource/inter",
    "@fontsource-variable/inter"
  ]);
});

test("extractGlobalStyleImports ignores CSS modules, ?inline imports, named imports and dynamic imports", () => {
  const source = [
    'import "./button.module.css";',
    'import "./inline.css?inline";',
    'import styles from "./named.css";',
    'import * as all from "./ns.css";',
    'void import("./dynamic.css");',
    'require("./required.css");',
    'import "./kept.css";'
  ].join("\n");
  const fileExists = exists(
    "src/button.module.css",
    "src/inline.css",
    "src/named.css",
    "src/ns.css",
    "src/dynamic.css",
    "src/required.css",
    "src/kept.css"
  );
  assert.deepEqual(extractGlobalStyleImports(source, "src/main.ts", fileExists), ["/src/kept.css"]);
});

test("extractGlobalStyleImports skips files that do not exist or escape the root", () => {
  const source = [
    'import "./missing.css";',
    'import "../../outside.css";',
    'import "/../etc/evil.css";',
    'import "./index.css";'
  ].join("\n");
  const asked: string[] = [];
  const result = extractGlobalStyleImports(source, "src/main.tsx", (p) => {
    asked.push(p);
    return p === "src/index.css";
  });
  assert.deepEqual(result, ["/src/index.css"]);
  assert.ok(!asked.some((p) => p.startsWith("..")), "paths escaping the root are never looked up");
});

test("extractGlobalStyleImports tolerates syntax errors after the imports", () => {
  const source = 'import "./index.css";\nimport "./theme.css";\nconst x = <div>{ ;\nexport default ((((';
  assert.deepEqual(extractGlobalStyleImports(source, "src/main.jsx", exists("src/index.css", "src/theme.css")), [
    "/src/index.css",
    "/src/theme.css"
  ]);
});

test("detectPackageManager prefers the packageManager field, then pnpm > yarn > npm lockfiles, default npm", () => {
  const pm = (pkg: { packageManager?: string }, files: string[]): string =>
    detectPackageManager(pkg, files).packageManager;
  assert.equal(pm({ packageManager: "yarn@4.1.0" }, ["pnpm-lock.yaml"]), "yarn");
  assert.equal(pm({ packageManager: "pnpm@9.0.0" }, []), "pnpm");
  assert.equal(pm({ packageManager: "npm@10.0.0" }, ["yarn.lock"]), "npm");
  assert.equal(pm({ packageManager: "bun@1.0.0" }, ["yarn.lock"]), "yarn");
  assert.equal(pm({}, ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"]), "pnpm");
  assert.equal(pm({}, ["yarn.lock", "package-lock.json"]), "yarn");
  assert.equal(pm({}, ["package-lock.json"]), "npm");
  assert.equal(pm({}, ["npm-shrinkwrap.json"]), "npm");
  assert.equal(pm({}, []), "npm");

  assert.deepEqual(detectPackageManager({}, ["yarn.lock", "package-lock.json"]).warnings, [
    "Multiple lockfiles found; using yarn"
  ]);
  assert.deepEqual(detectPackageManager({}, ["bun.lockb"]), {
    packageManager: "npm",
    warnings: ["Bun lockfile found; Bun is not supported, falling back to npm semantics"]
  });
  assert.deepEqual(detectPackageManager({}, ["package-lock.json"]).warnings, []);
});

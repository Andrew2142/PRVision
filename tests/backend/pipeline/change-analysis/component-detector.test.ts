import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ComponentDetector,
  pascalFromFile
} from "../../../../backend/src/services/visualizations/pipeline/component-detector";
import type { ExportInfo, ModuleSummary } from "../../../../backend/src/types/change-analysis";

const detector = new ComponentDetector();

function summarize(source: string, file = "src/components/Thing.tsx"): ModuleSummary {
  return detector.summarize(detector.parse(file, source), { path: file, side: "head", role: "source", sizeBytes: 1 });
}

function exportOf(source: string, name: string, file?: string): ExportInfo {
  const found = summarize(source, file).exports.find((e) => e.exportName === name);
  assert.ok(found, `export ${name} not found`);
  return found;
}

test("detects exported function declaration returning JSX", () => {
  const info = exportOf("export function Button() { return <button/> }", "Button");
  assert.equal(info.isComponent, true);
  assert.equal(info.shape, "function");
  assert.equal(info.displayName, "Button");
});

test("detects arrow function with concise JSX body", () => {
  const info = exportOf("export const Card = ({ title }: Props) => (<div>{title}</div>)", "Card");
  assert.equal(info.isComponent, true);
  assert.equal(info.shape, "arrow");
});

test("detects conditional and logical JSX returns", () => {
  const src = `
export function A({ on }: { on: boolean }) { return on ? <b/> : null }
export function B({ on }: { on: boolean }) { return on && <i/> }
export function C({ x }: { x?: JSX.Element }) { return x ?? <span/> }
export function D() { return React.createElement("div") }`;
  const summary = summarize(src);
  for (const name of ["A", "B", "C", "D"]) {
    assert.equal(summary.exports.find((e) => e.exportName === name)?.isComponent, true, name);
  }
});

test("detects memo-wrapped function expression", () => {
  const info = exportOf(
    `import { memo } from "react";
export const List = memo(function List() { return items.length ? <ul/> : null })`,
    "List"
  );
  assert.equal(info.isComponent, true);
  assert.deepEqual(info.wrappers, ["memo"]);
  assert.equal(info.shape, "function");
});

test("detects React.forwardRef with generics", () => {
  const info = exportOf(
    `import React from "react";
export const Input = React.forwardRef<HTMLInputElement, P>((p, ref) => <input ref={ref}/>)`,
    "Input"
  );
  assert.equal(info.isComponent, true);
  assert.deepEqual(info.wrappers, ["forwardRef"]);
});

test("detects memo(forwardRef()) nesting and records wrappers outermost first", () => {
  const info = exportOf(
    `import { memo, forwardRef } from "react";
export const IconButton = memo(forwardRef<HTMLButtonElement, { icon: string }>((p, ref) => <button ref={ref}>{p.icon}</button>));`,
    "IconButton"
  );
  assert.equal(info.isComponent, true);
  assert.deepEqual(info.wrappers, ["memo", "forwardRef"]);
});

test("resolves export default identifier to local declaration", () => {
  const info = exportOf(
    `import React from "react";
const Inner = (p) => <i/>;
export default React.memo(Inner)`,
    "default"
  );
  assert.equal(info.isComponent, true);
  assert.equal(info.localName, "Inner");
  assert.equal(info.displayName, "Inner");
  assert.deepEqual(info.wrappers, ["memo"]);
  const plain = exportOf("function Panel() { return <div/> }\nexport default Panel;", "default");
  assert.equal(plain.isComponent, true);
  assert.equal(plain.localName, "Panel");
});

test("resolves export { X as default }", () => {
  const info = exportOf("function Modal() { return <div/> } export { Modal as default }", "default");
  assert.equal(info.isComponent, true);
  assert.equal(info.localName, "Modal");
  assert.equal(info.displayName, "Modal");
});

test("names anonymous default export from file name", () => {
  const info = exportOf("export default function () { return <main/> }", "default", "src/pages/settings-page.tsx");
  assert.equal(info.isComponent, true);
  assert.equal(info.localName, null);
  assert.equal(info.displayName, "SettingsPage");
  assert.equal(pascalFromFile("src/components/Card.module.css"), "Card");
  assert.equal(pascalFromFile("src/1-thing.tsx"), "Component");
});

test("uses parent folder name for index files", () => {
  const info = exportOf("export default () => <div/>", "default", "src/components/user-card/index.tsx");
  assert.equal(info.displayName, "UserCard");
});

test("honours static displayName assignment", () => {
  const info = exportOf(`export const Fancy = () => <div/>;\nFancy.displayName = "FancyThing";`, "Fancy");
  assert.equal(info.displayName, "FancyThing");
});

test("detects class extending React.Component with render", () => {
  const info = exportOf(
    `import React from "react";
export class Legacy extends React.Component { render() { return <div/> } }`,
    "Legacy"
  );
  assert.equal(info.isComponent, true);
  assert.equal(info.shape, "class");
});

test("detects class extending imported PureComponent", () => {
  const info = exportOf(
    `import { PureComponent as Base } from "react";
export default class Pure extends Base { render = () => <p/> }`,
    "default"
  );
  assert.equal(info.isComponent, true);
  assert.equal(info.shape, "class");
  const notReact = exportOf(`export class Other extends Thing { render() { return <div/> } }`, "Other");
  assert.equal(notReact.isComponent, false);
});

test("rejects lowercase names and hooks", () => {
  assert.equal(exportOf("export const useCart = () => { return <b/> }", "useCart").isComponent, false);
  assert.equal(exportOf("export function helper() { return <b/> }", "helper").isComponent, false);
  assert.equal(exportOf("function lower() { return <b/> }\nexport default lower;", "default").isComponent, false);
});

test("rejects functions returning only null", () => {
  assert.equal(exportOf("export function Empty() { return null }", "Empty").isComponent, false);
});

test("rejects JSX returned only from nested functions", () => {
  assert.equal(exportOf("export function Render() { const f = () => <b/>; return f }", "Render").isComponent, false);
});

test("rejects createContext and styled components", () => {
  const summary = summarize(`import { createContext } from "react";
import styled from "styled-components";
import { connect } from "react-redux";
function Panel() { return <div/> }
export const ThemeContext = createContext(null);
export const Box = styled.div\`color: red;\`;
export default connect(map)(Panel);`);
  for (const info of summary.exports) {
    assert.equal(info.isComponent, false, info.exportName);
  }
});

test("records export * and named re-exports as reexport imports", () => {
  const summary = summarize(`export * from "./Button";
export { A, default as B } from "./m";
export * as UI from "./ui";`);
  assert.equal(summary.exports.length, 0);
  const [star, named, ns] = summary.imports;
  assert.deepEqual(star, { specifier: "./Button", kind: "reexport", bindings: [], star: true, line: 1 });
  assert.deepEqual(named?.bindings, [
    { imported: "A", local: "A" },
    { imported: "default", local: "B" }
  ]);
  assert.equal(named.star, false);
  assert.deepEqual(ns?.bindings, [{ imported: "*", local: "UI" }]);
});

test("treats import-then-export as re-export", () => {
  const summary = summarize(`import X from "./X";
import { Y } from "./Y";
export { X, Y as default };`);
  assert.equal(summary.exports.length, 0);
  const reexports = summary.imports.filter((raw) => raw.kind === "reexport");
  assert.deepEqual(
    reexports.map((raw) => ({ specifier: raw.specifier, bindings: raw.bindings })),
    [
      { specifier: "./X", bindings: [{ imported: "default", local: "X" }] },
      { specifier: "./Y", bindings: [{ imported: "Y", local: "default" }] }
    ]
  );
});

test("ignores type-only exports for component detection", () => {
  const summary = summarize(`export interface Props { a: string }
export type Alias = () => JSX.Element;
type Local = { b: number };
export type { Local };
export enum Color { Red }`);
  const byName = new Map(summary.exports.map((e) => [e.exportName, e]));
  assert.equal(byName.get("Props")?.typeOnly, true);
  assert.equal(byName.get("Alias")?.typeOnly, true);
  assert.equal(byName.get("Local")?.typeOnly, true);
  assert.equal(byName.get("Color")?.typeOnly, false);
  assert.ok(summary.exports.every((e) => !e.isComponent));
  assert.equal(
    summarize(`import type { A } from "./a";\nimport { type B } from "./b";`).imports.length,
    0,
    "type-only imports create no runtime import"
  );
});

test("parses JSX in .js files", () => {
  const info = exportOf("export function Legacy() { return <div className='x'/> }", "Legacy", "src/Legacy.js");
  assert.equal(info.isComponent, true);
});

test("findRenderRoots returns the JSX return expressions", () => {
  const sf = detector.parse(
    "src/A.tsx",
    "export function A({ on }: { on: boolean }) { if (on) { return <b/> } const f = () => <i/>; return (<span/>) }"
  );
  const resolved = detector.findExport(sf, "A");
  assert.ok(resolved);
  assert.deepEqual(
    detector.findRenderRoots(resolved).map((node) => node.getText(sf)),
    ["<b/>", "<span/>"]
  );
});

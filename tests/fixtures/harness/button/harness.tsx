import type { ReactElement } from "react";
import { Button } from "../../src/components/Button/Button";

const noop = (): void => {};

export default function PRVisionHarness(): ReactElement {
  return (
    <div style={{ padding: 24, width: 360, display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start" }}>
      <Button variant="primary" onClick={noop}>Save changes</Button>
      <Button variant="secondary" onClick={noop}>Cancel</Button>
      <Button variant="danger" onClick={noop}>Delete project</Button>
      <Button variant="primary" loading onClick={noop}>Saving…</Button>
      <Button variant="primary" size="sm" disabled onClick={noop}>Archived</Button>
    </div>
  );
}

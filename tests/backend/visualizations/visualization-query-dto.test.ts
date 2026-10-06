import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { VisualizationConsoleQueryDTO } from "../../../backend/src/dtos/visualizations/visualization-console-query.dto";
import {
  parseStatusList,
  VisualizationListQueryDTO
} from "../../../backend/src/dtos/visualizations/visualization-list-query.dto";
import { Validation } from "../../../backend/src/utilities";

const validation = new Validation();

test("VisualizationListQueryDTO coerces page, pageSize and repositoryId; rejects pageSize 101", async () => {
  const [ok, , dto] = await validation.validate(
    { page: "2", pageSize: "50", repositoryId: "7" },
    VisualizationListQueryDTO
  );
  assert.equal(ok, true);
  assert.deepEqual(
    { page: dto.page, pageSize: dto.pageSize, repositoryId: dto.repositoryId },
    {
      page: 2,
      pageSize: 50,
      repositoryId: 7
    }
  );
  const [tooBig, error] = await validation.validate({ pageSize: "101" }, VisualizationListQueryDTO);
  assert.equal(tooBig, false);
  assert.equal(error.error_reason, "validation_failed");
  assert.equal((await validation.validate({ repositoryId: "abc" }, VisualizationListQueryDTO))[0], false);
});

test('VisualizationListQueryDTO status parses "queued, rendering,,queued" to ["queued","rendering"] and ?status=a&status=b the same way', async () => {
  const [ok, , dto] = await validation.validate({ status: "queued, rendering,,queued" }, VisualizationListQueryDTO);
  assert.equal(ok, true);
  assert.deepEqual(dto.status, ["queued", "rendering"]);
  const [okArray, , dtoArray] = await validation.validate(
    { status: ["queued", "rendering"] },
    VisualizationListQueryDTO
  );
  assert.equal(okArray, true);
  assert.deepEqual(dtoArray.status, ["queued", "rendering"]);
  assert.deepEqual(parseStatusList(["a,b", "b"]), ["a", "b"]);
  assert.equal(parseStatusList(undefined), undefined);
});

test("VisualizationListQueryDTO status rejects an unknown status and an empty value", async () => {
  assert.equal((await validation.validate({ status: "queued,bogus" }, VisualizationListQueryDTO))[0], false);
  assert.equal((await validation.validate({ status: "" }, VisualizationListQueryDTO))[0], false);
  assert.equal((await validation.validate({}, VisualizationListQueryDTO))[0], true);
});

test("VisualizationConsoleQueryDTO accepts afterId 0 and rejects limit 501 and a negative afterId", async () => {
  const [ok, , dto] = await validation.validate({ afterId: "0", limit: "500" }, VisualizationConsoleQueryDTO);
  assert.equal(ok, true);
  assert.deepEqual({ afterId: dto.afterId, limit: dto.limit }, { afterId: 0, limit: 500 });
  assert.equal((await validation.validate({ limit: "501" }, VisualizationConsoleQueryDTO))[0], false);
  assert.equal((await validation.validate({ afterId: "-1" }, VisualizationConsoleQueryDTO))[0], false);
  assert.equal((await validation.validate({ limit: "0" }, VisualizationConsoleQueryDTO))[0], false);
  assert.equal((await validation.validate({ other: "1" }, VisualizationConsoleQueryDTO))[0], false);
});

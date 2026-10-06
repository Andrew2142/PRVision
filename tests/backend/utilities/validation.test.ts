import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "class-transformer";
import { IsInt, IsString, Min, ValidateNested } from "class-validator";
import { IdParamDTO } from "../../../backend/src/dtos/shared/id-param.dto";
import { PaginationQueryDTO } from "../../../backend/src/dtos/shared/pagination-query.dto";
import { Validation } from "../../../backend/src/utilities/validation/validation";

class ChildDTO {
  @IsInt()
  @Min(1)
  size!: number;
}

class ParentDTO {
  @IsString()
  name!: string;

  @ValidateNested()
  @Type(() => ChildDTO)
  child!: ChildDTO;
}

const validation = new Validation();

test("Validation.validate passes a valid body and returns the DTO instance", async () => {
  const [isValid, errorResponse, dto] = await validation.validate({ name: "a", child: { size: 2 } }, ParentDTO);
  assert.equal(isValid, true);
  assert.equal(errorResponse, null);
  assert.ok(dto instanceof ParentDTO);
  assert.equal(dto.child.size, 2);
});

test("Validation.validate rejects an unknown property (forbidNonWhitelisted)", async () => {
  const [isValid, errorResponse] = await validation.validate({ name: "a", child: { size: 2 }, extra: 1 }, ParentDTO);
  assert.equal(isValid, false);
  assert.ok(Array.isArray(errorResponse.error));
  assert.match(String(errorResponse.error), /extra should not exist/);
});

test('IdParamDTO accepts "12" and rejects "0", "-1", "abc", "1.5"', async () => {
  const [ok, , dto] = await validation.validate({ id: "12" }, IdParamDTO);
  assert.equal(ok, true);
  assert.equal(dto.id, 12);
  for (const id of ["0", "-1", "abc", "1.5"]) {
    const [isValid] = await validation.validate({ id }, IdParamDTO);
    assert.equal(isValid, false, `id ${id} must be rejected`);
  }
});

test("PaginationQueryDTO rejects pageSize 101 and accepts an empty query", async () => {
  const [tooBig] = await validation.validate({ pageSize: "101" }, PaginationQueryDTO);
  assert.equal(tooBig, false);
  const [empty] = await validation.validate({}, PaginationQueryDTO);
  assert.equal(empty, true);
});

test("Validation.validate flattens nested errors with property paths", async () => {
  const [isValid, errorResponse] = await validation.validate({ name: "a", child: { size: 0 } }, ParentDTO);
  assert.equal(isValid, false);
  assert.deepEqual(errorResponse.error, ["child.size: size must not be less than 1"]);
});

test("Validation.compileJsonData returns {} for arrays, numbers and invalid JSON strings", () => {
  assert.deepEqual(validation.compileJsonData([1, 2]), {});
  assert.deepEqual(validation.compileJsonData(42), {});
  assert.deepEqual(validation.compileJsonData("{not json"), {});
  assert.deepEqual(validation.compileJsonData(undefined), {});
  assert.deepEqual(validation.compileJsonData('{"a":1}'), { a: 1 });
  assert.deepEqual(validation.compileJsonData({ b: 2 }), { b: 2 });
});

test("Validation.validate error response carries error_reason validation_failed", async () => {
  const [, errorResponse] = await validation.validate({ id: "x" }, IdParamDTO);
  assert.equal(errorResponse?.status, 400);
  assert.equal(errorResponse.error_reason, "validation_failed");
});

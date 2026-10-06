import assert from "node:assert/strict";
import test from "node:test";
import { DTOMapper } from "../../../backend/src/utilities/mappers/dto-mapper";

class TargetModel {
  private _name!: string;
  private _count!: number;
  plain: string | undefined = undefined;
  setName(value: string): void {
    this._name = value;
  }
  setCount(value: number): void {
    this._count = value;
  }
  get name(): string {
    return this._name;
  }
  get count(): number {
    return this._count;
  }
}

test("DTOMapper.map maps via setters and falls back to own properties", () => {
  const model = DTOMapper.map({ name: "repo", count: 2, plain: "p", other: "dropped" }, TargetModel);
  assert.equal(model.name, "repo");
  assert.equal(model.count, 2);
  assert.equal(model.plain, "p");
  assert.equal(Object.prototype.hasOwnProperty.call(model, "other"), false);
});

test("DTOMapper.map skips null and undefined values", () => {
  const model = DTOMapper.map({ name: null, count: undefined }, TargetModel);
  assert.equal(model.name, undefined);
  assert.equal(model.count, undefined);
});

test("DTOMapper.map throws on a non-object DTO", () => {
  assert.throws(() => DTOMapper.map(null as unknown as object, TargetModel), /DTO must be a valid object/);
});

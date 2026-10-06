import assert from "node:assert/strict";
import test from "node:test";
import { ModelHandler } from "../../../backend/src/utilities/handlers/model-handler";

class SampleModel {
  private _id!: number;
  private _name!: string | null;
  private _secret!: string;
  setId(value: number): void {
    this._id = value;
  }
  setName(value: string | null): void {
    this._name = value;
  }
  setSecret(value: string): void {
    this._secret = value;
  }
  get id(): number {
    return this._id;
  }
  get name(): string | null {
    return this._name;
  }
  get secret(): string {
    return this._secret;
  }
}

test("ModelHandler.hydrate calls setters including for null values", () => {
  const model = ModelHandler.hydrate(SampleModel, { id: 4, name: null, unknownKey: "ignored" });
  assert.equal(model.id, 4);
  assert.equal(model.name, null);
});

test("ModelHandler.toDatabaseValues drops null and excluded keys", () => {
  const model = ModelHandler.hydrate(SampleModel, { id: 4, name: null, secret: "x" });
  assert.deepEqual(ModelHandler.toDatabaseValues(model, ["secret"]), { id: 4 });
});

test("ModelHandler.removeUndefined keeps null and drops undefined", () => {
  assert.deepEqual(ModelHandler.removeUndefined({ a: 1, b: undefined, c: null }), { a: 1, c: null });
});

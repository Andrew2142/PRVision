import { parseRouteId } from './route-params.util';

describe('parseRouteId', () => {
  it("'42' → 42", () => {
    expect(parseRouteId('42')).toBe(42);
  });

  it("'0' → null", () => {
    expect(parseRouteId('0')).toBeNull();
  });

  it("'abc' → null", () => {
    expect(parseRouteId('abc')).toBeNull();
  });

  it("'1e3' → null", () => {
    expect(parseRouteId('1e3')).toBeNull();
  });

  it('undefined → null', () => {
    expect(parseRouteId(undefined)).toBeNull();
    expect(parseRouteId(null)).toBeNull();
    expect(parseRouteId('')).toBeNull();
  });
});

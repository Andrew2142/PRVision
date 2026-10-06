/** Route/query param → positive integer id, or null for anything else (13 §5.1). Null means "render not found". */
export function parseRouteId(raw: string | null | undefined): number | null {
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

import { DETAIL_VIEWS, defaultDetailView, parseDetailView } from './detail-views';

describe('detail-views', () => {
  it('parseDetailView accepts the three views only', () => {
    expect(DETAIL_VIEWS.map((v) => parseDetailView(v))).toEqual(['components', 'summary', 'console']);
    expect(parseDetailView(undefined)).toBeNull();
    expect(parseDetailView(null)).toBeNull();
    expect(parseDetailView('')).toBeNull();
    expect(parseDetailView('Summary')).toBeNull();
    expect(parseDetailView('harness')).toBeNull();
  });

  it('defaultDetailView is Summary for a completed run, otherwise Console', () => {
    expect(defaultDetailView('completed')).toBe('summary');
    expect(defaultDetailView('rendering')).toBe('console');
    expect(defaultDetailView('queued')).toBe('console');
    expect(defaultDetailView('failed')).toBe('console');
    expect(defaultDetailView('cancelled')).toBe('console');
    expect(defaultDetailView(null)).toBe('console');
  });
});

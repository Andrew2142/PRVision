import { RelativeTimePipe } from './relative-time.pipe';

describe('RelativeTimePipe', () => {
  const pipe = new RelativeTimePipe();

  it('just now', () => {
    expect(pipe.transform(new Date())).toBe('just now');
  });

  it('1 min ago', () => {
    expect(pipe.transform(new Date(Date.now() - 90_000).toISOString())).toBe('1 min ago');
    expect(pipe.transform(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3 hr ago');
    expect(pipe.transform(new Date(Date.now() - 4 * 86_400_000).toISOString())).toBe('4 days ago');
  });

  it('naive ISO treated as UTC', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000 - 60_000);
    const naive = twoHoursAgo.toISOString().replace('Z', '').slice(0, 19);
    expect(pipe.transform(naive)).toBe('2 hr ago');
  });

  it('null → fallback', () => {
    expect(pipe.transform(null)).toBe('—');
    expect(pipe.transform(undefined, 'never')).toBe('never');
    expect(pipe.transform('not a date', 'n/a')).toBe('n/a');
  });
});

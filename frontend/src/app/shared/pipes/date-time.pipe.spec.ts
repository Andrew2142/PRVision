import { DateTimePipe } from './date-time.pipe';

describe('DateTimePipe', () => {
  const pipe = new DateTimePipe();
  const iso = '2026-03-14T15:09:26Z';
  const date = new Date(iso);

  it('medium/date/time styles', () => {
    expect(pipe.transform(iso)).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date),
    );
    expect(pipe.transform(iso, 'date')).toBe(
      new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date),
    );
    expect(pipe.transform(iso, 'time')).toBe(new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(date));
  });

  it('invalid → fallback', () => {
    expect(pipe.transform('garbage')).toBe('—');
    expect(pipe.transform(null, 'medium', 'never')).toBe('never');
  });
});

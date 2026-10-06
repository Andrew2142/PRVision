import { CompactNumberPipe } from './compact-number.pipe';

describe('CompactNumberPipe', () => {
  const pipe = new CompactNumberPipe();

  it('12345 → 12.3K', () => {
    const expected = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(12345);
    expect(pipe.transform(12345)).toBe(expected);
    expect(new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(12345)).toBe(
      '12.3K',
    );
  });

  it('null → —', () => {
    expect(pipe.transform(null)).toBe('—');
    expect(pipe.transform(undefined)).toBe('—');
  });
});

import { DiffPercentPipe, formatDiffPercent } from './diff-percent.pipe';

describe('DiffPercentPipe', () => {
  const pipe = new DiffPercentPipe();

  it('formats ratios as percentages', () => {
    expect(pipe.transform(null)).toBe('—');
    expect(pipe.transform(0)).toBe('0%');
    expect(pipe.transform(0.00005)).toBe('<0.01%');
    expect(pipe.transform(0.00123)).toBe('0.12%');
    expect(pipe.transform(0.0123)).toBe('1.2%');
    expect(pipe.transform(0.05)).toBe('5.0%');
    expect(pipe.transform(0.42)).toBe('42%');
    expect(pipe.transform(1.5)).toBe('100%');
  });

  it('formatDiffPercent is the same function for component code', () => {
    expect(formatDiffPercent(0.0123)).toBe('1.2%');
    expect(formatDiffPercent(undefined)).toBe('—');
  });
});

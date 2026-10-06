import { ShortShaPipe } from './short-sha.pipe';

describe('ShortShaPipe', () => {
  const pipe = new ShortShaPipe();

  it('7 chars', () => {
    expect(pipe.transform('0123456789abcdef')).toBe('0123456');
    expect(pipe.transform('0123456789abcdef', 10)).toBe('0123456789');
  });

  it('null', () => {
    expect(pipe.transform(null)).toBe('—');
    expect(pipe.transform('')).toBe('—');
  });
});

import { BytesPipe } from './bytes.pipe';

describe('BytesPipe', () => {
  const pipe = new BytesPipe();

  it('0 B', () => {
    expect(pipe.transform(0)).toBe('0 B');
    expect(pipe.transform(512)).toBe('512 B');
  });

  it('1.5 KB', () => {
    expect(pipe.transform(1536)).toBe('1.5 KB');
    expect(pipe.transform(5 * 1024 * 1024)).toBe('5 MB');
  });

  it('negative → —', () => {
    expect(pipe.transform(-1)).toBe('—');
    expect(pipe.transform(Number.NaN)).toBe('—');
    expect(pipe.transform(null)).toBe('—');
  });
});

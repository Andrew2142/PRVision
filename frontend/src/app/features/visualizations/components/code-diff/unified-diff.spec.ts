import { countDiffStats, parseUnifiedDiff } from './unified-diff';

const SAMPLE = [
  'diff --git a/src/Button.tsx b/src/Button.tsx',
  'index 1111111..2222222 100644',
  '--- a/src/Button.tsx',
  '+++ b/src/Button.tsx',
  '@@ -10,4 +10,5 @@ export function Button() {',
  '   const a = 1;',
  '-  return <button className="red">;',
  '+  return <button className="blue">;',
  '+  // added',
  '   const b = 2;',
  '\\ No newline at end of file',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('parses headers as meta', () => {
    const lines = parseUnifiedDiff(SAMPLE);
    expect(lines.slice(0, 4).map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'meta']);
    expect(lines[2]?.text).toBe('--- a/src/Button.tsx');
    expect(lines[0]?.oldNo).toBeNull();
  });

  it('hunk header sets line numbers', () => {
    const lines = parseUnifiedDiff(SAMPLE);
    expect(lines[4]).toEqual(jasmine.objectContaining({ kind: 'hunk', oldNo: null, newNo: null }));
    expect(lines[5]).toEqual(
      jasmine.objectContaining({ kind: 'context', oldNo: 10, newNo: 10, text: '  const a = 1;' }),
    );
  });

  it('add/del/context numbering', () => {
    const lines = parseUnifiedDiff(SAMPLE);
    expect(lines[6]).toEqual(jasmine.objectContaining({ kind: 'del', oldNo: 11, newNo: null }));
    expect(lines[6]?.text).toBe('  return <button className="red">;');
    expect(lines[7]).toEqual(jasmine.objectContaining({ kind: 'add', oldNo: null, newNo: 11 }));
    expect(lines[8]).toEqual(jasmine.objectContaining({ kind: 'add', oldNo: null, newNo: 12 }));
    expect(lines[9]).toEqual(jasmine.objectContaining({ kind: 'context', oldNo: 12, newNo: 13 }));
  });

  it('"\\ No newline" is note', () => {
    const lines = parseUnifiedDiff(SAMPLE);
    expect(lines[10]).toEqual(
      jasmine.objectContaining({ kind: 'note', oldNo: null, newNo: null, text: '\\ No newline at end of file' }),
    );
    expect(lines.length).toBe(11); // trailing empty line dropped
  });

  it('CRLF input', () => {
    const lines = parseUnifiedDiff(SAMPLE.replace(/\n/g, '\r\n'));
    expect(lines.length).toBe(11);
    expect(lines.some((l) => l.text.includes('\r'))).toBeFalse();
    expect(lines[7]?.text).toBe('  return <button className="blue">;');
  });

  it('content line "--- x" inside a hunk is a deletion', () => {
    const diff = ['diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', '@@ -1,2 +1,1 @@', '--- x', ' keep'].join(
      '\n',
    );
    const lines = parseUnifiedDiff(diff);
    expect(lines[4]).toEqual(jasmine.objectContaining({ kind: 'del', oldNo: 1, text: '-- x' }));
    expect(lines[5]).toEqual(jasmine.objectContaining({ kind: 'context', oldNo: 2, newNo: 1 }));
  });

  it('multiple files in one diff', () => {
    const second = [
      'diff --git a/src/Badge.tsx b/src/Badge.tsx',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/Badge.tsx',
      '@@ -0,0 +1,2 @@',
      '+export const Badge = 1;',
      '+export default Badge;',
    ].join('\n');
    const lines = parseUnifiedDiff(`${SAMPLE}${second}\n`);
    const secondStart = lines.findIndex((l) => l.text.startsWith('diff --git a/src/Badge.tsx'));
    expect(lines.slice(secondStart, secondStart + 4).every((l) => l.kind === 'meta')).toBeTrue();
    expect(lines[secondStart + 5]).toEqual(jasmine.objectContaining({ kind: 'add', newNo: 1 }));
    expect(lines[secondStart + 6]).toEqual(jasmine.objectContaining({ kind: 'add', newNo: 2 }));
  });

  it('keys are unique and sequential', () => {
    const lines = parseUnifiedDiff(SAMPLE);
    expect(lines.map((l) => l.key)).toEqual(lines.map((_, i) => i));
  });

  it('countDiffStats', () => {
    expect(countDiffStats(SAMPLE)).toEqual({ added: 2, removed: 1 });
    expect(countDiffStats('')).toEqual({ added: 0, removed: 0 });
  });
});

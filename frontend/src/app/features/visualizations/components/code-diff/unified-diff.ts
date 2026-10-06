export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context' | 'note';

/** `key` is the line's position in the parsed diff; used as the @for track key (01: no $index). */
export interface DiffLine {
  key: number;
  kind: DiffLineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

/**
 * For reference: the header lines git writes before the first hunk of a file section. They are recognised by
 * position (anything before the first `@@` of a section is meta), not by prefix, so that a content line such as
 * `--- x` inside a hunk stays a deletion.
 */
export const META_PREFIXES = [
  'diff --git',
  'index ',
  '--- ',
  '+++ ',
  'new file mode',
  'deleted file mode',
  'similarity index',
  'rename from',
  'rename to',
  'old mode',
  'new mode',
  'Binary files',
] as const;

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines = diff.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out: DiffLine[] = [];
  const push = (line: Omit<DiffLine, 'key'>): void => {
    out.push({ key: out.length, ...line });
  };
  const meta = (text: string): void => {
    push({ kind: 'meta', oldNo: null, newNo: null, text });
  };
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of lines) {
    if (raw.startsWith('diff --git')) {
      // new file section
      inHunk = false;
      meta(raw);
      continue;
    }
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      push({ kind: 'hunk', oldNo: null, newNo: null, text: raw });
      continue;
    }
    if (!inHunk) {
      // index/mode/---/+++/rename lines before the first hunk
      meta(raw);
      continue;
    }
    if (raw.startsWith('+')) push({ kind: 'add', oldNo: null, newNo: newNo++, text: raw.slice(1) });
    else if (raw.startsWith('-')) push({ kind: 'del', oldNo: oldNo++, newNo: null, text: raw.slice(1) });
    else if (raw.startsWith('\\')) push({ kind: 'note', oldNo: null, newNo: null, text: raw });
    else push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text: raw.startsWith(' ') ? raw.slice(1) : raw });
  }
  return out;
}

export function countDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of parseUnifiedDiff(diff)) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  return { added, removed };
}

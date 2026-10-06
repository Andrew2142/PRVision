import { formatPillLabel, isSafeGithubUrl, providerLabel, refsLabel, sourceLabel } from './labels.util';

describe('labels.util', () => {
  const noShas = { baseSha: null, headSha: null };
  const range = {
    sourceType: 'commit_range' as const,
    prNumber: null,
    baseRef: 'feature/x',
    headRef: 'feature/x',
    baseSha: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
    headSha: 'e4f5a6b7c8d9e0f1a2b3e4f5a6b7c8d9e0f1a2b3',
  };

  it('sourceLabel for each source type', () => {
    expect(sourceLabel({ sourceType: 'github_pr', prNumber: 42, headRef: 'feature/x', ...noShas })).toBe('PR #42');
    expect(sourceLabel({ sourceType: 'local_branch', prNumber: null, headRef: 'feature/x', ...noShas })).toBe(
      'Branch feature/x',
    );
    expect(sourceLabel({ sourceType: 'working_tree', prNumber: null, headRef: 'working-tree', ...noShas })).toBe(
      'Working tree',
    );
    expect(sourceLabel(range)).toBe('Commits a1b2c3d…e4f5a6b on feature/x');
    expect(sourceLabel({ ...range, baseSha: null })).toBe('Commits ?…e4f5a6b on feature/x');
  });

  it('refsLabel for branch, working tree and commit range', () => {
    expect(refsLabel({ sourceType: 'local_branch', baseRef: 'main', headRef: 'feature/x', ...noShas })).toBe(
      'main ← feature/x',
    );
    expect(refsLabel({ sourceType: 'working_tree', baseRef: 'main', headRef: 'working-tree', ...noShas })).toBe(
      'main ← working tree',
    );
    expect(refsLabel(range)).toBe('feature/x: a1b2c3d ← e4f5a6b');
  });

  it('formatPillLabel snake_case', () => {
    expect(formatPillLabel('generating_harnesses')).toBe('Generating Harnesses');
    expect(formatPillLabel('likely-regression')).toBe('Likely Regression');
    expect(formatPillLabel('')).toBe('—');
    expect(formatPillLabel(null)).toBe('—');
    expect(formatPillLabel('feature/x')).toBe('feature/x');
  });

  it('isSafeGithubUrl accepts https://github.com/…, rejects http, javascript:, other hosts', () => {
    expect(isSafeGithubUrl('https://github.com/acme/app/pull/7')).toBeTrue();
    expect(isSafeGithubUrl('http://github.com/acme/app/pull/7')).toBeFalse();
    expect(isSafeGithubUrl('javascript:alert(1)')).toBeFalse();
    expect(isSafeGithubUrl('https://github.com.evil.io/acme')).toBeFalse();
    expect(isSafeGithubUrl('https://gitlab.com/acme/app')).toBeFalse();
    expect(isSafeGithubUrl(null)).toBeFalse();
  });

  it('providerLabel maps anthropic_api and claude_code, title-cases unknown values', () => {
    expect(providerLabel('anthropic_api')).toBe('Anthropic API');
    expect(providerLabel('claude_code')).toBe('Claude Code');
    expect(providerLabel('some_other')).toBe('Some Other');
  });
});

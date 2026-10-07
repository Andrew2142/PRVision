import { estimateView } from '../../features/repositories/testing/library-fixtures';
import {
  defaultSpendCap,
  estimateErrorText,
  estimateText,
  formatUsd,
  isTerminalLibraryJob,
  jobProgressPercent,
  jobProgressText,
  libraryJobTitle,
  plural,
} from './library-format.util';

describe('library-format', () => {
  it('formatUsd: two decimals under $10, whole dollars from $10', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(4.5)).toBe('$4.50');
    expect(formatUsd(9.994)).toBe('$9.99');
    expect(formatUsd(12.3)).toBe('$12');
    expect(formatUsd(38.6)).toBe('$39');
    expect(formatUsd(1234.4)).toBe('$1,234');
  });

  it('jobProgressText reads "84 of 201 harnesses written, about $12 spent"', () => {
    expect(jobProgressText({ processedCount: 84, totalCount: 201, spentUsd: 12.4 })).toBe(
      '84 of 201 harnesses written, about $12 spent',
    );
    expect(jobProgressText({ processedCount: 3, totalCount: 40, spentUsd: 0.57 })).toBe(
      '3 of 40 harnesses written, about $0.57 spent',
    );
  });

  it('jobProgressPercent', () => {
    expect(jobProgressPercent({ processedCount: 84, totalCount: 201 })).toBe(42);
    expect(jobProgressPercent({ processedCount: 0, totalCount: 0 })).toBe(0);
    expect(jobProgressPercent({ processedCount: 5, totalCount: 4 })).toBe(100);
  });

  it('terminal statuses', () => {
    expect(isTerminalLibraryJob('completed')).toBeTrue();
    expect(isTerminalLibraryJob('cap_reached')).toBeTrue();
    expect(isTerminalLibraryJob('failed')).toBeTrue();
    expect(isTerminalLibraryJob('cancelled')).toBeTrue();
    expect(isTerminalLibraryJob('queued')).toBeFalse();
    expect(isTerminalLibraryJob('preparing')).toBeFalse();
    expect(isTerminalLibraryJob('running')).toBeFalse();
  });

  it('job titles', () => {
    expect(libraryJobTitle({ kind: 'scan', repositoryName: 'my-shop', visualizationId: null })).toBe('Scan · my-shop');
    expect(libraryJobTitle({ kind: 'rescan', repositoryName: 'my-shop', visualizationId: null })).toBe(
      'Rescan · my-shop',
    );
    expect(libraryJobTitle({ kind: 'repair', repositoryName: 'my-shop', visualizationId: 42 })).toBe(
      'Repair · run #42',
    );
  });

  it('estimateText for the Add repository dialog (scan and grow)', () => {
    const text = estimateText(estimateView(), 'components');
    expect(`${text.count} · about ${text.cost} ${text.detail}`).toBe(
      '201 components · about $38 (between $23 and $61) with claude-opus-5-5 at 3 states · about 84 minutes',
    );
    expect(text.growLine).toBe(
      '201 components. Writing all of them now would cost about $38; growing as you go costs nothing upfront.',
    );
    expect(text.priceNote).toBeNull();
  });

  it('estimateText for the scan dialog counts what is left to write', () => {
    const text = estimateText(
      estimateView({ toWriteCount: 12, estimatedUsd: 2.28, lowUsd: 1.37, highUsd: 3.65, estimatedMinutes: 1 }),
      'toWrite',
    );
    expect(`${text.count} · about ${text.cost} ${text.detail}`).toBe(
      '12 of 201 components to write · about $2.28 (between $1.37 and $3.65) with claude-opus-5-5 at 3 states · about 1 minute',
    );
  });

  it('estimateText singulars and the approximate price note', () => {
    const text = estimateText(
      estimateView({
        componentCount: 1,
        stateAllowance: 1,
        model: 'claude-next',
        priceModel: 'claude-fable-5-1',
        priceExact: false,
      }),
      'components',
    );
    expect(text.count).toBe('1 component');
    expect(text.detail).toContain('at 1 state ·');
    expect(text.priceNote).toBe("No published price for claude-next; using claude-fable-5-1's price.");
  });

  it('defaultSpendCap = max(1, ceil(highUsd))', () => {
    expect(defaultSpendCap({ highUsd: 61.12 })).toBe(62);
    expect(defaultSpendCap({ highUsd: 0.3 })).toBe(1);
    expect(defaultSpendCap({ highUsd: 3 })).toBe(3);
  });

  it('estimateErrorText adds one full stop', () => {
    expect(estimateErrorText('Counting components took too long; the estimate is unavailable.')).toBe(
      'Could not estimate: Counting components took too long; the estimate is unavailable.',
    );
    expect(estimateErrorText('No app')).toBe('Could not estimate: No app.');
  });

  it('plural', () => {
    expect(plural(1, 'harness', 'harnesses')).toBe('1 harness');
    expect(plural(2, 'harness', 'harnesses')).toBe('2 harnesses');
  });
});

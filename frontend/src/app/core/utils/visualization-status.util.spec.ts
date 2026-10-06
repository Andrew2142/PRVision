import { VISUALIZATION_STATUSES } from '../models/domain-enums.model';
import { PIPELINE_STAGES, isTerminalStatus, stageIndex } from './visualization-status.util';

describe('visualization-status.util', () => {
  it('isTerminalStatus for each status', () => {
    const terminal = VISUALIZATION_STATUSES.filter((s) => isTerminalStatus(s));
    expect(terminal).toEqual(['completed', 'failed', 'cancelled']);
  });

  it('stageIndex order matches PIPELINE_STAGES', () => {
    PIPELINE_STAGES.forEach((stage, index) => {
      expect(stageIndex(stage.status)).toBe(index);
    });
    expect(PIPELINE_STAGES.map((s) => s.status)).toEqual([
      'queued',
      'preparing',
      'analyzing',
      'generating_harnesses',
      'rendering',
      'diffing',
      'summarizing',
    ]);
  });

  it('terminal or unknown → -1', () => {
    expect(stageIndex('completed')).toBe(-1);
    expect(stageIndex('failed')).toBe(-1);
    expect(stageIndex('cancelled')).toBe(-1);
    expect(stageIndex('nonsense')).toBe(-1);
  });
});

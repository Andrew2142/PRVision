import { FormControl, FormGroup } from '@angular/forms';
import { type SettingsView } from '../../core/models/settings.model';
import {
  AI_MODEL_PATTERN,
  type SecretClearFlags,
  type SettingsFormValue,
  anthropicKeyHint,
  anthropicKeyRequired,
  buildSettingsUpdate,
  githubTokenHint,
} from './settings-form';

const SAVED: SettingsView = {
  hasGithubToken: true,
  githubLogin: 'octocat',
  aiProvider: 'anthropic_api',
  hasAnthropicApiKey: true,
  aiModel: 'claude-opus-5-5',
  aiHarnessEffort: 'high',
  aiSummaryEffort: 'medium',
};

const UNCHANGED: SettingsFormValue = {
  githubToken: '',
  aiProvider: 'anthropic_api',
  anthropicApiKey: '',
  aiModel: 'claude-opus-5-5',
  aiHarnessEffort: 'high',
  aiSummaryEffort: 'medium',
};

const NO_CLEAR: SecretClearFlags = { githubToken: false, anthropicApiKey: false };

describe('buildSettingsUpdate', () => {
  it('blank secret omitted', () => {
    const update = buildSettingsUpdate(SAVED, UNCHANGED, NO_CLEAR);
    expect('githubToken' in update).toBeFalse();
    expect('anthropicApiKey' in update).toBeFalse();
  });

  it('typed secret trimmed and sent', () => {
    const update = buildSettingsUpdate(
      SAVED,
      { ...UNCHANGED, githubToken: '  github_pat_abc ', anthropicApiKey: ' sk-ant-1 ' },
      NO_CLEAR,
    );
    expect(update).toEqual({ githubToken: 'github_pat_abc', anthropicApiKey: 'sk-ant-1' });
  });

  it('clear flag sends "" (never null)', () => {
    const update = buildSettingsUpdate(SAVED, UNCHANGED, { githubToken: true, anthropicApiKey: true });
    expect(update).toEqual({ githubToken: '', anthropicApiKey: '' });
    expect(Object.values(update)).not.toContain(null);
  });

  it('clear wins over typed value', () => {
    const update = buildSettingsUpdate(
      SAVED,
      { ...UNCHANGED, githubToken: 'ghp_new' },
      { ...NO_CLEAR, githubToken: true },
    );
    expect(update.githubToken).toBe('');
  });

  it('whitespace-only secret omitted', () => {
    const update = buildSettingsUpdate(SAVED, { ...UNCHANGED, githubToken: '   ', anthropicApiKey: '\t' }, NO_CLEAR);
    expect(update).toEqual({});
  });

  it('unchanged non-secret fields omitted', () => {
    expect(buildSettingsUpdate(SAVED, { ...UNCHANGED, aiModel: ' claude-opus-5-5 ' }, NO_CLEAR)).toEqual({});
  });

  it('changed model/efforts included', () => {
    const update = buildSettingsUpdate(
      SAVED,
      {
        ...UNCHANGED,
        aiModel: 'claude-sonnet-5',
        aiHarnessEffort: 'max',
        aiSummaryEffort: 'low',
      },
      NO_CLEAR,
    );
    expect(update).toEqual({
      aiModel: 'claude-sonnet-5',
      aiHarnessEffort: 'max',
      aiSummaryEffort: 'low',
    });
  });

  it('a saved legacy claude_code provider is switched to anthropic_api', () => {
    expect(buildSettingsUpdate({ ...SAVED, aiProvider: 'claude_code' }, UNCHANGED, NO_CLEAR)).toEqual({
      aiProvider: 'anthropic_api',
    });
  });
});

describe('AI_MODEL_PATTERN', () => {
  it("accepts claude-opus-5-5 and rejects uppercase, spaces and a leading dot (05's rule)", () => {
    expect(AI_MODEL_PATTERN.test('claude-opus-5-5')).toBeTrue();
    expect(AI_MODEL_PATTERN.test('claude-3.5-sonnet')).toBeTrue();
    expect(AI_MODEL_PATTERN.test('Claude-Opus')).toBeFalse();
    expect(AI_MODEL_PATTERN.test('claude opus')).toBeFalse();
    expect(AI_MODEL_PATTERN.test('.claude')).toBeFalse();
  });
});

describe('anthropicKeyRequired', () => {
  function group(key: string): FormGroup {
    return new FormGroup({
      anthropicApiKey: new FormControl(key, { nonNullable: true }),
    });
  }

  it('error when no saved key and nothing typed', () => {
    const validator = anthropicKeyRequired(
      () => false,
      () => false,
    );
    expect(validator(group(''))).toEqual({ anthropicKeyRequired: true });
    expect(validator(group('   '))).toEqual({ anthropicKeyRequired: true });
    expect(validator(group('sk-ant-x'))).toBeNull();
  });

  it('no error when saved key exists', () => {
    const validator = anthropicKeyRequired(
      () => true,
      () => false,
    );
    expect(validator(group(''))).toBeNull();
  });

  it('error when saved key being cleared', () => {
    const validator = anthropicKeyRequired(
      () => true,
      () => true,
    );
    expect(validator(group(''))).toEqual({ anthropicKeyRequired: true });
  });
});

describe('token hints', () => {
  it('githubTokenHint', () => {
    expect(githubTokenHint('')).toBeNull();
    expect(githubTokenHint('github_pat_123')).toBeNull();
    expect(githubTokenHint('ghp_123')).toBeNull();
    expect(githubTokenHint('abc')).toBe('This does not look like a GitHub token (expected github_pat_… or ghp_…).');
  });

  it('anthropicKeyHint', () => {
    expect(anthropicKeyHint('')).toBeNull();
    expect(anthropicKeyHint('sk-ant-api03-x')).toBeNull();
    expect(anthropicKeyHint('sk-xyz')).toBe('Anthropic API keys usually start with sk-ant-.');
  });
});

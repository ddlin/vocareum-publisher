import { describe, it, expect } from 'vitest';
import { NonInteractivePrompter, UnresolvedDecisionError } from '../../src/core/services/context';
import type { RuntimeFacts } from '../../src/core/services/context';

describe('NonInteractivePrompter', () => {
  const prompter = new NonInteractivePrompter();

  it('rejects confirm with UnresolvedDecisionError', async () => {
    await expect(prompter.confirm('Proceed?')).rejects.toThrow(UnresolvedDecisionError);
    await expect(prompter.confirm('Proceed?')).rejects.toMatchObject({ name: 'UnresolvedDecisionError' });
  });

  it('rejects choice with UnresolvedDecisionError', async () => {
    await expect(prompter.choice('Pick one', ['a', 'b'])).rejects.toThrow(UnresolvedDecisionError);
    await expect(prompter.choice('Pick one', ['a', 'b'])).rejects.toMatchObject({ name: 'UnresolvedDecisionError' });
  });

  it('rejects input with UnresolvedDecisionError', async () => {
    await expect(prompter.input('Enter value')).rejects.toThrow(UnresolvedDecisionError);
    await expect(prompter.input('Enter value')).rejects.toMatchObject({ name: 'UnresolvedDecisionError' });
  });
});

describe('RuntimeFacts', () => {
  it('type-checks with authMode token', () => {
    const facts: RuntimeFacts = {
      ci: false,
      authMode: 'token',
      credentialLabel: 'VOCAREUM_TOKEN',
      credentialsConfigured: true,
    };
    expect(facts.authMode).toBe('token');
  });

  it('type-checks with authMode oauth', () => {
    const facts: RuntimeFacts = {
      ci: true,
      ciProvider: 'github',
      authMode: 'oauth',
      credentialLabel: 'OAuth',
      credentialsConfigured: false,
    };
    expect(facts.authMode).toBe('oauth');
  });
});

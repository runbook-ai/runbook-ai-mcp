import { effortIterations, tokenBudgets } from '../src/budget';

describe('token budgets', () => {
  it('follows the extension effort rule for iterations', () => {
    expect(effortIterations(15)).toBe(15);
    expect(effortIterations(15, 'normal')).toBe(15);
    expect(effortIterations(15, 'bogus')).toBe(15);
    expect(effortIterations(15, 'quick')).toBe(10);
    expect(effortIterations(3, 'quick')).toBe(5);
    expect(effortIterations(15, 'thorough')).toBe(23);
  });

  it('gives 100k input / 4k output tokens per effort-adjusted iteration', () => {
    expect(tokenBudgets(15)).toEqual({ maxInputTokens: 1_500_000, maxOutputTokens: 60_000 });
    expect(tokenBudgets(15, 'thorough')).toEqual({ maxInputTokens: 2_300_000, maxOutputTokens: 92_000 });
    expect(tokenBudgets(15, 'quick')).toEqual({ maxInputTokens: 1_000_000, maxOutputTokens: 40_000 });
  });
});

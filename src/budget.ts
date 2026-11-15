// Token budgets for one browser-agent run. The iteration count is the real
// limit; the token budgets only stop a runaway run. Every turn re-sends the
// whole conversation plus the current page, so a turn on a real page costs
// well over 30k input tokens -- the old 30k-per-iteration budget ran out
// long before the iterations did ("Input tokens exceeded limit").
export const INPUT_TOKENS_PER_ITERATION = 100_000;
export const OUTPUT_TOKENS_PER_ITERATION = 1_000;

// The iterations the extension actually allows for an effort level
// (auto-chrome extension/prompts.js effortMaxIterations; keep in sync):
// quick 2/3 (at least 5), thorough 1.5x, anything else as given.
export function effortIterations(maxIterations: number, effort?: string): number {
  if (effort === 'quick') return Math.max(5, Math.ceil(maxIterations * 2 / 3));
  if (effort === 'thorough') return Math.ceil(maxIterations * 1.5);
  return maxIterations;
}

export function tokenBudgets(maxIterations: number, effort?: string) {
  const iterations = effortIterations(maxIterations, effort);
  return {
    maxInputTokens: iterations * INPUT_TOKENS_PER_ITERATION,
    maxOutputTokens: iterations * OUTPUT_TOKENS_PER_ITERATION,
  };
}

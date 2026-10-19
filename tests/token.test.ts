import { resolveToken } from '../src/token';

describe('resolveToken', () => {
  it('reads --token <t> and --token=<t>', () => {
    expect(resolveToken(['--token', 'abc'], {})).toBe('abc');
    expect(resolveToken(['--token=abc'], {})).toBe('abc');
  });
  it('prefers the command line over the env var', () => {
    expect(resolveToken(['--token', 'cli'], { RUNBOOK_AI_MCP_TOKEN: 'env' })).toBe('cli');
  });
  it('falls back to RUNBOOK_AI_MCP_TOKEN, else empty', () => {
    expect(resolveToken([], { RUNBOOK_AI_MCP_TOKEN: ' env ' })).toBe('env');
    expect(resolveToken([], {})).toBe('');
    expect(resolveToken(['--token'], {})).toBe('');
  });
});

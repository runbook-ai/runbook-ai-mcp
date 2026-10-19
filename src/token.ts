// MCP token: when the extension has a token set (Settings > MCP token), every
// task-request must carry the same value or the extension refuses it. Read
// from `--token <t>` / `--token=<t>`, else RUNBOOK_AI_MCP_TOKEN. The env var
// keeps the token out of `ps` output, which other local users can read.
export function resolveToken(argv: string[], env: NodeJS.ProcessEnv): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--token' && i + 1 < argv.length) return argv[i + 1].trim();
    if (a.startsWith('--token=')) return a.slice('--token='.length).trim();
  }
  return (env.RUNBOOK_AI_MCP_TOKEN || '').trim();
}

#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CancelledNotificationSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'path';
import { Hub } from './hub.js';
import { WorkerClient } from './worker-client.js';
import { writeTaskFiles, formatFilesFooter, imageContentItems, newRunDir, dropResultEcho } from './files.js';

const WS_PORT = parseInt(process.env.WS_PORT || '9003');

// Create components
let hub: Hub | null = null;
const worker = new WorkerClient(WS_PORT);

// Progress tracking
let activeProgressToken: string | number | null = null;
let progressCount = 0;

// Track request IDs that the client has cancelled. Any response or progress
// notification emitted after cancel must be dropped — otherwise the client
// will see "unknown message ID" / "unknown progress token" and tear down the
// stdio transport (leaving this worker orphaned).
const cancelledRequestIds = new Set<string | number>();
const cancelledProgressTokens = new Set<string | number>();

// Listen for task-update messages and send progress notifications
worker.on('task-update', (message: any) => {
  const taskUpdate = message.taskUpdate || {};
  
  // Skip tool-response to reduce clutter
  if (taskUpdate.role === 'tool-response') return;
  
  let data = taskUpdate.data;
  if (taskUpdate.role === 'tool-call') {
    data = `${data.arguments?.description || data.name}`;
  }
  
  if (activeProgressToken !== null && !cancelledProgressTokens.has(activeProgressToken)) {
    progressCount++;
    server.notification({
      method: 'notifications/progress',
      params: {
        progressToken: activeProgressToken,
        progress: progressCount,
        total: undefined,
        message: data,
      },
    });
  }
});

// Define the browser-agent tool
const BROWSER_AGENT_TOOL: Tool = {
  name: 'browser-agent',
  description: 'Run a task in Chrome browser with AI and automation capabilities. ' +
    'Files the agent produces during the run (data it saves to a file, downloads, extracted datasets, screenshots) ' +
    'are written to disk on this machine and their absolute paths are listed at the end of the result; ' +
    'image files are additionally returned inline. To get bulk data (e.g. a scraped list or API payload) without ' +
    'it flooding the result text, ask the agent to save it to a named file.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task prompt for the AI agent to execute',
      },
      maxIterations: {
        type: 'number',
        description: 'Maximum number of iterations for the AI agent (default: 15)',
      },
      ephemeral: {
        type: 'boolean',
        description: 'Run in an ephemeral browser session (default: true): the task starts on a fresh blank tab, cannot see tabs left by previous runs, and every tab it opens is closed when it finishes. Set to false to continue from the tabs of a previous call and leave the final page open.',
      },
      effort: {
        type: 'string',
        enum: ['quick', 'normal', 'thorough'],
        description: "How much exploration the agent invests (default: normal). 'quick': one fast pass over loaded content, missing optional details reported as \"not specified\", tighter iteration budget. 'thorough': follow all pagination, open detail pages, check candidates one by one, larger iteration budget. Accuracy rules apply at every level.",
      },
      outputDir: {
        type: 'string',
        description: 'Directory on this machine to write files the agent produces (created if missing; existing files with the same name are overwritten). Default: a fresh per-call directory under $RUNBOOK_AI_FILES_DIR or the OS temp dir (runbook-ai-mcp/task-<timestamp>).',
      },
    },
    required: ['prompt'],
  },
};

// Create MCP server
const server = new Server(
  {
    name: 'runbook-ai-mcp',
    version: '1.0.14',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle tool list requests
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [BROWSER_AGENT_TOOL],
  };
});

// Handle cancellation notifications
server.setNotificationHandler(CancelledNotificationSchema, async (notification) => {
  const requestId = (notification.params as any)?.requestId;
  console.error(`[MCP] Received cancellation notification for request ${requestId}`);
  if (requestId !== undefined && requestId !== null) {
    cancelledRequestIds.add(requestId);
    // Drop the cancellation record after a grace period so the set doesn't grow unbounded.
    setTimeout(() => cancelledRequestIds.delete(requestId), 60_000);
  }
  if (activeProgressToken !== null) {
    cancelledProgressTokens.add(activeProgressToken);
    const token = activeProgressToken;
    setTimeout(() => cancelledProgressTokens.delete(token), 60_000);
    activeProgressToken = null;
  }
  worker.sendCancellation();
});

// Budget accounting appended to every result. When the agent wraps up with
// "ran out of budget" prose, this line is what tells the caller whether it
// starved on iterations or tokens, and by how much, so maxIterations can be
// tuned instead of guessed. Extensions older than budgetStats return nothing.
function formatBudgetFooter(stats: any): string {
  if (!stats || typeof stats !== 'object') return '';
  const pair = (used: any, max: any) =>
    `${used ?? '?'}/${max ?? 'unlimited'}`;
  const elapsed = typeof stats.elapsedMs === 'number'
    ? `, elapsed ${Math.round(stats.elapsedMs / 1000)}s` : '';
  return `\n\n[budget: iterations ${pair(stats.iterationsUsed, stats.maxIterations)}` +
    `, input tokens ${pair(stats.inputTokens, stats.maxInputTokens)}` +
    `, output tokens ${pair(stats.outputTokens, stats.maxOutputTokens)}${elapsed}]`;
}

// Handle tool call requests
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  activeProgressToken = (request.params as any)._meta?.progressToken || null;
  progressCount = 0;

  if (name !== 'browser-agent') {
    return {
      content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }],
    };
  }

  const prompt = (args as any).prompt;
  const maxIterations = (args as any).maxIterations || 15;
  const outputDirArg = (args as any).outputDir;
  if (outputDirArg !== undefined && (typeof outputDirArg !== 'string' || !outputDirArg.trim())) {
    return {
      content: [{ type: 'text', text: 'Error: outputDir must be a non-empty string when provided' }],
    };
  }
  if (!prompt || typeof prompt !== 'string') {
    return {
      content: [{ type: 'text', text: 'Error: Prompt is required and must be a string' }],
    };
  }

  // Check if worker is connected to hub
  if (!worker.isConnected()) {
    return {
      content: [{ type: 'text', text: 'Error: Not connected to Runbook AI Hub. Please wait a few seconds or ensure port 9003 is available.' }],
    };
  }

  const config = {
    maxIterations,
    maxInputTokens: maxIterations * 30000,
    maxOutputTokens: maxIterations * 1000,
    // Ephemeral by default: MCP calls are independent one-shot runs, so each
    // starts on a fresh blank tab and cleans up every tab it opened
    // (auto-chrome/docs/tab-management.md). Pass ephemeral: false to chain
    // calls that build on the previous call's tabs.
    ephemeralSession: (args as any).ephemeral !== false,
    // Exploration depth (auto-chrome/docs/task-effort.md); unknown values
    // behave like 'normal' on the extension side.
    ...(typeof (args as any).effort === 'string' ? { taskEffort: (args as any).effort } : {}),
  };

  const response = await worker.invokeTool({
    name: 'runHeadlessTaskWithConfig',
    args: { prompt, initialTaskState: null, config },
  });

  if (response.error) {
    return {
      content: [{ type: 'text', text: `Error: ${response.error}` }],
    };
  }

  if (response.result?.taskResult?.result) {
    // Files the agent saved/downloaded ride along on the response as
    // base64. Write them to disk and hand back paths (never the content --
    // the point of saving to a file is to keep bulk data out of context);
    // small images are also returned inline so screenshots are visible.
    let filesFooter = '';
    let imageItems: { type: 'image'; data: string; mimeType: string }[] = [];
    const files = dropResultEcho(response.result.files, response.result.taskResult.result);
    if (files && typeof files === 'object' && Object.keys(files).length > 0) {
      const outputDir = outputDirArg ? path.resolve(outputDirArg) : newRunDir();
      let written;
      try {
        written = writeTaskFiles(files, outputDir);
      } catch (e: any) {
        written = { outputDir, written: [], failed: [{ name: '*', error: e?.message || String(e) }] };
      }
      filesFooter = formatFilesFooter(written);
      imageItems = imageContentItems(files, written.written);
    }
    return {
      content: [
        {
          type: 'text',
          text: response.result.taskResult.result + filesFooter + formatBudgetFooter(response.result.budgetStats),
        },
        ...imageItems,
      ],
    };
  }

  return {
    content: [{ type: 'text', text: 'Error: Unexpected response format from browser extension' }],
  };
});

// Hub election and connection loop
async function maintainConnection() {
  // If we don't have a hub, try to become one
  if (!hub) {
    const newHub = new Hub(WS_PORT);
    try {
      await newHub.start();
      hub = newHub;
      console.error('[Main] Successfully became the Hub');
    } catch (err: any) {
      if (err.code === 'EADDRINUSE') {
        // Someone else is the hub, that's fine
      } else {
        console.error('[Main] Error starting hub:', err);
      }
    }
  }

  // Always try to ensure worker is connected
  worker.connect();

  // Schedule next check
  setTimeout(maintainConnection, 3000);
}

// Start the server
async function main() {
  const transport = new StdioServerTransport();

  // Wrap transport.send to drop outbound messages for requests that the
  // client has already cancelled. Sending a response or progress notification
  // for a cancelled id causes Claude Code (and other MCP clients) to treat it
  // as a protocol violation and close the transport.
  const originalSend = transport.send.bind(transport);
  transport.send = (message: any) => {
    // Drop responses to cancelled request IDs (result or error).
    if (
      message &&
      typeof message === 'object' &&
      'id' in message &&
      message.id !== undefined &&
      message.id !== null &&
      ('result' in message || 'error' in message) &&
      cancelledRequestIds.has(message.id)
    ) {
      console.error(`[MCP] Dropping response for cancelled request ${message.id}`);
      return Promise.resolve();
    }
    // Drop progress notifications for cancelled progress tokens.
    if (
      message &&
      typeof message === 'object' &&
      message.method === 'notifications/progress' &&
      message.params?.progressToken !== undefined &&
      cancelledProgressTokens.has(message.params.progressToken)
    ) {
      console.error(`[MCP] Dropping progress notification for cancelled token ${message.params.progressToken}`);
      return Promise.resolve();
    }
    return originalSend(message);
  };

  // When the client closes stdin (e.g. parent Claude Code exits or the
  // transport is torn down), the SDK's StdioServerTransport does not exit
  // the process — the ws hub + setTimeout loop keep the event loop alive
  // and the worker lingers forever as an orphan. Exit explicitly so another
  // session can take over the hub role cleanly.
  const exitOnStdinEnd = () => {
    console.error('[Main] stdin closed, exiting');
    process.exit(0);
  };
  process.stdin.on('end', exitOnStdinEnd);
  process.stdin.on('close', exitOnStdinEnd);

  await server.connect(transport);
  console.error('Runbook AI MCP server started');

  maintainConnection();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

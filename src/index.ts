#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CancelledNotificationSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { Hub } from './hub.js';
import { WorkerClient } from './worker-client.js';

const WS_PORT = parseInt(process.env.WS_PORT || '9003');

// Create components
let hub: Hub | null = null;
const worker = new WorkerClient(WS_PORT);

// Progress tracking
let activeProgressToken: string | null = null;
let progressCount = 0;

// Listen for task-update messages and send progress notifications
worker.on('task-update', (message: any) => {
  const taskUpdate = message.taskUpdate || {};
  
  // Skip tool-response to reduce clutter
  if (taskUpdate.role === 'tool-response') return;
  
  let data = taskUpdate.data;
  if (taskUpdate.role === 'tool-call') {
    data = `${data.arguments?.description || data.name}`;
  }
  
  if (activeProgressToken) {
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
  description: 'Run a task in Chrome browser with AI and automation capabilities',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task prompt for the AI agent to execute',
      },
    },
    required: ['prompt'],
  },
};

// Create MCP server
const server = new Server(
  {
    name: 'runbook-ai-mcp',
    version: '1.0.5',
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
  console.error('[MCP] Received cancellation notification');
  worker.sendCancellation();
});

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

  const response = await worker.invokeTool({
    name: 'runHeadlessTask',
    args: { prompt },
  });

  if (response.error) {
    return {
      content: [{ type: 'text', text: `Error: ${response.error}` }],
    };
  }

  if (response.result?.taskResult?.result) {
    return {
      content: [{ type: 'text', text: response.result.taskResult.result }],
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
  await server.connect(transport);
  console.error('Runbook AI MCP server started');
  
  maintainConnection();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

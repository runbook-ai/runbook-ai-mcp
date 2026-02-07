#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CancelledNotificationSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer } from './websocket-server.js';

const WS_PORT = parseInt(process.env.WS_PORT || '9003');

// Create WebSocket server for browser extension communication
const wsServer = new WebSocketServer(WS_PORT);

// Track if a tool call is in progress
let isToolCallInProgress = false;

// Listen for task-update messages and send progress notifications
wsServer.on('task-update', (message: any) => {
  const taskUpdate = message.taskUpdate || {};
  
  // Skip tool-response to reduce clutter
  if (taskUpdate.role === 'tool-response') return;
  
  let data = taskUpdate.data;
  if (taskUpdate.role === 'tool-call') {
    data = `${data.arguments?.description || data.name}`;
  }
  
  // Send progress notification to MCP client
  const notification = wsServer.sendProgressNotification(data);
  if (notification) {
    server.notification(notification);
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
    version: '0.1.0',
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
  wsServer.sendCancellation();
});

// Handle tool call requests
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const progressToken = (request.params as any)._meta?.progressToken;
  
  // Set progress token for notifications
  wsServer.setProgressToken(progressToken || null);

  if (name !== 'browser-agent') {
    return {
      content: [
        {
          type: 'text',
          text: `Error: Unknown tool: ${name}`,
        },
      ],
    };
  }

  if (!args || typeof args !== 'object') {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: Invalid arguments',
        },
      ],
    };
  }

  const prompt = (args as any).prompt;
  if (!prompt || typeof prompt !== 'string') {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: Prompt is required and must be a string',
        },
      ],
    };
  }

  // Check if extension is connected
  if (!wsServer.isConnected()) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: Browser extension not connected. Please ensure the extension side panel is open with MCP enabled.',
        },
      ],
    };
  }

  // Check if another tool call is in progress
  if (isToolCallInProgress) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: Another tool call is already in progress. Please wait for it to complete.',
        },
      ],
    };
  }

  // Set flag to prevent concurrent calls
  isToolCallInProgress = true;

  let response;
  try {
    // Invoke the tool via WebSocket
    response = await wsServer.invokeTool({
      name: 'runHeadlessTask',
      args: { prompt },
    });
  } finally {
    // Clear flag when tool call completes
    isToolCallInProgress = false;
  }

  if (response.error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${response.error}`,
        },
      ],
    };
  }

  // runHeadlessTask returns { text, taskResult, tokenStats }
  if (response.result?.taskResult?.result) {
    const resultText = response.result.taskResult.result;
    
    return {
      content: [
        {
          type: 'text',
          text: resultText,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: 'Error: Unexpected response format from browser extension',
      },
    ],
  };
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Runbook AI MCP server started');
  console.error(`WebSocket server listening on port ${WS_PORT}`);
  console.error(`Connect your Chrome extension to: ws://localhost:${WS_PORT}`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

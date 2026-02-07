# Runbook AI MCP Server

An MCP (Model Context Protocol) server that provides browser automation capabilities through a Chrome extension.

## Installation

### MCP Server

Add to your MCP settings configuration:

```json
{
  "mcpServers": {
    "runbook-ai": {
      "command": "npx",
      "args": ["-y", "runbook-ai-mcp@latest"]
    }
  }
}
```

### Chrome Extension

Install the [Runbook AI](https://chromewebstore.google.com/detail/runbook-ai/kjbhngehjkiiecaflccjenmoccielojj) extension from Chrome Web Store.

Enable MCP in the extension settings.

## Usage

Open Chrome and keep the extension side panel open.

Start the MCP server (it will automatically start when invoked by your MCP client).

## Tool Schema

The server exposes a single tool:

### `browser-agent`

Run a task in Chrome browser with AI and automation capabilities.

**Parameters:**
- `prompt` (string, required): The task prompt for the AI agent to execute

**Example:**

```json
{
  "name": "browser-agent",
  "arguments": {
    "prompt": "Go to google.com and search for 'MCP protocol'"
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development mode
npm run dev

# Run tests
npm test
```

## Architecture

1. **MCP Server**: Communicates with MCP clients via stdio
2. **WebSocket Server**: Listens for Chrome extension connections on port 9003
3. **Chrome Extension**: Executes browser automation tasks

When a tool is invoked:
1. MCP client sends request to MCP server via stdio
2. MCP server forwards request to Chrome extension via WebSocket
3. Extension executes the task and returns result
4. Result is sent back to MCP client

import { spawn, ChildProcess } from 'child_process';
import WebSocket from 'ws';

describe('Integration Test', () => {
  let serverProcess: ChildProcess;
  const WS_PORT = 9998;

  beforeAll((done) => {
    // Start the MCP server
    serverProcess = spawn('node', ['dist/index.js'], {
      env: { ...process.env, WS_PORT: WS_PORT.toString() },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Wait for server to start
    setTimeout(done, 2000);
  }, 10000);

  afterAll((done) => {
    if (serverProcess) {
      serverProcess.kill();
    }
    setTimeout(done, 1000);
  });

  it('should accept WebSocket connections', (done) => {
    const client = new WebSocket(`ws://localhost:${WS_PORT}`);

    client.on('open', () => {
      expect(true).toBe(true);
      client.close();
      done();
    });

    client.on('error', (error) => {
      done(new Error(`Connection failed: ${error.message}`));
    });
  }, 10000);

  it('should handle tool invocation via WebSocket', (done) => {
    const client = new WebSocket(`ws://localhost:${WS_PORT}`);

    client.on('open', () => {
      // Server should send a request
      client.on('message', (data) => {
        const request = JSON.parse(data.toString());
        expect(request.name).toBe('runHeadlessTask');
        expect(request.args.prompt).toBeDefined();

        // Send response
        const response = {
          command: 'task-response',
          result: {
            content: [
              { type: 'text', text: 'Test response' }
            ]
          }
        };
        client.send(JSON.stringify(response));
      });

      // Send a tool call request to the MCP server via stdin
      const mcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'browser-agent',
          arguments: {
            prompt: 'Test prompt'
          }
        }
      };

      if (serverProcess.stdin) {
        serverProcess.stdin.write(JSON.stringify(mcpRequest) + '\n');
      }

      // Wait a bit then close
      setTimeout(() => {
        client.close();
        done();
      }, 2000);
    });
  }, 15000);
});

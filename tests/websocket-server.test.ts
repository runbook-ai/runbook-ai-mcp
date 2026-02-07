import { WebSocketServer } from '../src/websocket-server';
import WebSocket from 'ws';

describe('WebSocketServer', () => {
  let server: WebSocketServer;
  const TEST_PORT = 9999;

  beforeEach((done) => {
    server = new WebSocketServer(TEST_PORT);
    server.on('listening', () => {
      done();
    });
    // Emit listening immediately in setupServer, so wait a tick
    setTimeout(() => {
      if (!server.isConnected()) {
        done();
      }
    }, 100);
  });

  afterEach((done) => {
    server.close();
    setTimeout(done, 100);
  });

  it('should create server on specified port', () => {
    expect(server.isConnected()).toBe(false);
  });

  it('should handle extension connection', (done) => {
    server.on('connected', () => {
      expect(server.isConnected()).toBe(true);
      done();
    });

    // Simulate extension connecting
    const client = new WebSocket(`ws://localhost:${TEST_PORT}`);
  });

  it('should handle extension disconnection', (done) => {
    let client: WebSocket;

    server.on('connected', () => {
      expect(server.isConnected()).toBe(true);
      // Add small delay to ensure connection is fully established
      setTimeout(() => {
        client.close();
      }, 50);
    });

    server.on('disconnected', () => {
      expect(server.isConnected()).toBe(false);
      done();
    });

    client = new WebSocket(`ws://localhost:${TEST_PORT}`);
  });

  it('should return error when extension not connected', async () => {
    const response = await server.invokeTool({
      name: 'browser-agent',
      args: { prompt: 'test' }
    });

    expect(response.error).toBeDefined();
    expect(response.error).toContain('not connected');
  });

  it('should send request and receive response', (done) => {
    const testPrompt = 'test prompt';
    const testResponse = {
      command: 'task-response',
      text: 'Task completed',
      taskResult: null
    };
    let client: WebSocket;

    server.on('connected', async () => {
      // Client should receive the request
      client.on('message', (data) => {
        const request = JSON.parse(data.toString());
        expect(request.name).toBe('runHeadlessTask');
        expect(request.args.prompt).toBe(testPrompt);

        // Send response back
        client.send(JSON.stringify(testResponse));
      });

      // Invoke tool
      const response = await server.invokeTool({
        name: 'runHeadlessTask',
        args: { prompt: testPrompt }
      });

      expect(response.result.text).toBe('Task completed');
      client.close();
      done();
    });

    client = new WebSocket(`ws://localhost:${TEST_PORT}`);
  }, 10000);

  it('should timeout on no response', async () => {
    let client: WebSocket;

    await new Promise<void>((resolve) => {
      server.on('connected', () => resolve());
      client = new WebSocket(`ws://localhost:${TEST_PORT}`);
    });

    // Mock short timeout for testing
    const originalTimeout = setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation((cb: any, ms?: number) => {
      if (ms === 300000) {
        return originalTimeout(cb, 100) as any;
      }
      return originalTimeout(cb, ms) as any;
    });

    const response = await server.invokeTool({
      name: 'browser-agent',
      args: { prompt: 'test' }
    });

    expect(response.error).toBeDefined();
    expect(response.error).toContain('timeout');

    client!.close();
  }, 10000);
});

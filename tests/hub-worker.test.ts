import { Hub } from '../src/hub';
import { WorkerClient } from '../src/worker-client';
import WebSocket from 'ws';

describe('Hub and WorkerClient', () => {
  let hub: Hub;
  let worker: WorkerClient;
  const TEST_PORT = 9999;

  beforeEach(async () => {
    hub = new Hub(TEST_PORT);
    await hub.start();
    worker = new WorkerClient(TEST_PORT);
  });

  afterEach(() => {
    hub.close();
    if (worker.isConnected()) {
      (worker as any).ws.close();
    }
  });

  it('should allow worker to connect to hub', (done) => {
    worker.on('connected', () => {
      expect(worker.isConnected()).toBe(true);
      done();
    });
    worker.connect();
  });

  it('should handle tool invocation through hub to extension', (done) => {
    const testPrompt = 'test prompt';
    const testResponse = {
      command: 'task-response',
      text: 'Task completed',
      taskResult: { result: 'Success' }
    };

    // Simulate extension
    const extension = new WebSocket(`ws://localhost:${TEST_PORT}/`);
    
    extension.on('open', () => {
      worker.on('connected', async () => {
        // Extension should receive the request forwarded by Hub
        extension.on('message', (data) => {
          const request = JSON.parse(data.toString());
          expect(request.command).toBe('task-request');
          expect(request.args.prompt).toBe(testPrompt);

          // Send response back from extension
          extension.send(JSON.stringify(testResponse));
        });

        // Invoke tool on worker
        const response = await worker.invokeTool({
          name: 'runHeadlessTask',
          args: { prompt: testPrompt }
        });

        expect(response.result.text).toBe('Task completed');
        expect(response.result.taskResult.result).toBe('Success');
        extension.close();
        done();
      });
      worker.connect();
    });
  });

  it('should pass task files through hub to worker unchanged', (done) => {
    const files = {
      'orders.json': { name: 'orders.json', mimeType: 'application/json', base64: Buffer.from('[1,2,3]').toString('base64'), size: 7 },
    };
    const extension = new WebSocket(`ws://localhost:${TEST_PORT}/`);
    extension.on('open', () => {
      worker.on('connected', async () => {
        extension.on('message', () => {
          extension.send(JSON.stringify({
            command: 'task-response',
            text: 'Task completed',
            taskResult: { result: 'Saved orders' },
            files,
          }));
        });
        const response = await worker.invokeTool({
          name: 'runHeadlessTaskWithConfig',
          args: { prompt: 'save orders', initialTaskState: null, config: {} }
        });
        expect(response.result.taskResult.result).toBe('Saved orders');
        expect(response.result.files).toEqual(files);
        extension.close();
        done();
      });
      worker.connect();
    });
  });

  it('should reject second task if hub is busy', (done) => {
    const extension = new WebSocket(`ws://localhost:${TEST_PORT}/`);
    const worker2 = new WorkerClient(TEST_PORT);

    extension.on('open', () => {
      worker.on('connected', () => {
        worker2.on('connected', async () => {
          // Start first task (don't wait for it to finish)
          const promise1 = worker.invokeTool({
            name: 'runHeadlessTask',
            args: { prompt: 'task 1' }
          });

          // Try starting second task immediately
          const response2 = await worker2.invokeTool({
            name: 'runHeadlessTask',
            args: { prompt: 'task 2' }
          });

          expect(response2.error).toContain('Another instance is currently using the browser');
          
          extension.close();
          done();
        });
        worker2.connect();
      });
      worker.connect();
    });
  });

  it('should fail if extension is not connected', (done) => {
    worker.on('connected', async () => {
      const response = await worker.invokeTool({
        name: 'runHeadlessTask',
        args: { prompt: 'test' }
      });

      expect(response.error).toContain('Browser extension not connected');
      done();
    });
    worker.connect();
  });
});

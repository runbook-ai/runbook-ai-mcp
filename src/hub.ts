import WebSocket, { WebSocketServer as WSServer } from 'ws';
import { EventEmitter } from 'events';
import http from 'http';

export class Hub extends EventEmitter {
  private wss: WSServer;
  private server: http.Server;
  private extensionWs: WebSocket | null = null;
  private workers: Set<WebSocket> = new Set();
  private activeWorker: WebSocket | null = null;
  private isBusy: boolean = false;
  private port: number;

  constructor(port: number = 9003) {
    super();
    this.port = port;
    this.server = http.createServer();
    this.wss = new WSServer({ noServer: true });
    this.setupServer();
  }

  private setupServer() {
    this.server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url || '/', `http://${request.headers.host}`).pathname;

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        if (pathname === '/hub') {
          this.handleWorkerConnection(ws);
        } else if (pathname === '/') {
          this.handleExtensionConnection(ws);
        } else {
          ws.close(1002, 'Invalid path');
        }
      });
    });
  }

  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on('error', (err: any) => {
        reject(err);
      });

      this.server.listen(this.port, () => {
        console.error(`[Hub] Listening on port ${this.port}`);
        resolve();
      });
    });
  }

  private handleWorkerConnection(ws: WebSocket) {
    console.error('[Hub] Worker connected');
    this.workers.add(ws);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleWorkerMessage(ws, message);
      } catch (error) {
        console.error('[Hub] Error parsing worker message:', error);
      }
    });

    ws.on('close', () => {
      console.error('[Hub] Worker disconnected');
      this.workers.delete(ws);
      if (this.activeWorker === ws) {
        this.isBusy = false;
        this.activeWorker = null;
        // If the worker disconnected during a task, we should probably cancel it in the extension
        if (this.extensionWs && this.extensionWs.readyState === WebSocket.OPEN) {
          this.extensionWs.send(JSON.stringify({ command: 'task-cancellation' }));
        }
      }
    });
  }

  private handleExtensionConnection(ws: WebSocket) {
    if (this.extensionWs && this.extensionWs.readyState === WebSocket.OPEN) {
      console.error('[Hub] Rejecting new extension connection - already connected');
      ws.close(1008, 'Another extension is already connected');
      return;
    }

    console.error('[Hub] Browser extension connected');
    this.extensionWs = ws;

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleExtensionMessage(message);
      } catch (error) {
        console.error('[Hub] Error parsing extension message:', error);
      }
    });

    ws.on('close', () => {
      if (this.extensionWs !== ws) return;
      console.error('[Hub] Browser extension disconnected');
      this.extensionWs = null;
      if (this.activeWorker && this.activeWorker.readyState === WebSocket.OPEN) {
        this.activeWorker.send(JSON.stringify({
          command: 'task-response',
          error: 'Browser extension disconnected during task.'
        }));
      }
      this.isBusy = false;
      this.activeWorker = null;
    });
  }

  private handleWorkerMessage(ws: WebSocket, message: any) {
    if (message.command === 'task-request') {
      if (this.isBusy) {
        ws.send(JSON.stringify({ 
          command: 'task-response', 
          error: 'Task rejected: Another instance is currently using the browser.' 
        }));
        return;
      }

      if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
        ws.send(JSON.stringify({ 
          command: 'task-response', 
          error: 'Browser extension not connected. Please ensure the extension side panel is open with MCP enabled.' 
        }));
        return;
      }

      this.isBusy = true;
      this.activeWorker = ws;
      
      // Forward to extension
      this.extensionWs.send(JSON.stringify(message));
    } else if (message.command === 'task-cancellation') {
      if (this.activeWorker === ws && this.extensionWs) {
        this.extensionWs.send(JSON.stringify(message));
      }
    }
  }

  private handleExtensionMessage(message: any) {
    if (!this.activeWorker || this.activeWorker.readyState !== WebSocket.OPEN) {
      this.isBusy = false;
      this.activeWorker = null;
      return;
    }

    // Forward task-update or task-response to the active worker
    this.activeWorker.send(JSON.stringify(message));

    if (message.command === 'task-response') {
      this.isBusy = false;
      this.activeWorker = null;
    }
  }

  public close() {
    this.server.close();
  }
}

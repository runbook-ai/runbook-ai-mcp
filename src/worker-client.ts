import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface BrowserAgentRequest {
  name: string;
  args: {
    [key: string]: any;
  };
}

export interface BrowserAgentResponse {
  result?: any;
  error?: string;
}

export class WorkerClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private isConnecting: boolean = false;
  private pendingRequest: { resolve: (val: any) => void, reject: (err: any) => void } | null = null;

  constructor(port: number = 9003) {
    super();
    this.url = `ws://localhost:${port}/hub`;
  }

  public connect() {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;

    this.isConnecting = true;
    console.error(`[Worker] Connecting to Hub at ${this.url}`);
    
    const ws = new WebSocket(this.url);

    ws.on('open', () => {
      this.isConnecting = false;
      this.ws = ws;
      console.error('[Worker] Connected to Hub');
      this.emit('connected');
    });

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (error) {
        console.error('[Worker] Error parsing message:', error);
      }
    });

    ws.on('close', () => {
      this.isConnecting = false;
      this.ws = null;
      console.error('[Worker] Disconnected from Hub');
      this.emit('disconnected');
      
      // If there was a pending request, fail it
      if (this.pendingRequest) {
        this.pendingRequest.resolve({ error: 'Disconnected from Hub during task' });
        this.pendingRequest = null;
      }
    });

    ws.on('error', (error) => {
      this.isConnecting = false;
      // Connection errors are expected if Hub is not up yet
    });
  }

  private handleMessage(message: any) {
    if (message.command === 'task-response') {
      if (this.pendingRequest) {
        if (message.error) {
          this.pendingRequest.resolve({ error: message.error });
        } else {
          const { command, ...result } = message;
          this.pendingRequest.resolve({ result });
        }
        this.pendingRequest = null;
      }
    } else if (message.command === 'task-update') {
      this.emit('task-update', message);
    }
  }

  public async invokeTool(request: BrowserAgentRequest): Promise<BrowserAgentResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return {
        error: 'Not connected to Hub. Please ensure at least one MCP server instance is running and port 9003 is available.'
      };
    }

    if (this.pendingRequest) {
      return { error: 'Another task is already in progress from this instance.' };
    }

    return new Promise((resolve, reject) => {
      this.pendingRequest = { resolve, reject };

      const timeout = setTimeout(() => {
        if (this.pendingRequest) {
          this.sendCancellation();
          this.pendingRequest.resolve({ error: 'Tool invocation timeout after 300 seconds' });
          this.pendingRequest = null;
        }
      }, 300000);

      // Wrap resolve to clear timeout
      const originalResolve = resolve;
      this.pendingRequest.resolve = (val: any) => {
        clearTimeout(timeout);
        originalResolve(val);
      };

      this.ws!.send(JSON.stringify({
        command: 'task-request',
        name: request.name,
        args: request.args
      }));
    });
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public sendCancellation() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ command: 'task-cancellation' }));
    }
  }
}

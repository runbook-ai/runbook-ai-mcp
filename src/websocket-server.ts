import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface BrowserAgentRequest {
  name: string;
  args: {
    [key: string]: any;
  };
}

export interface BrowserAgentResponse {
  result?: any; // Result from callAction - structure depends on the action
  error?: string;
}

export class WebSocketServer extends EventEmitter {
  private wss: WebSocket.Server;
  private extensionWs: WebSocket | null = null;
  private port: number;
  private progressToken: string | null = null;
  private progressCount: number = 0;

  constructor(port: number = 9003) {
    super();
    this.port = port;
    this.wss = new WebSocket.Server({ port });
    this.setupServer();
  }

  private setupServer() {
    this.wss.on('connection', (ws: WebSocket) => {
      // Only allow one connection at a time
      if (this.extensionWs && this.extensionWs.readyState === WebSocket.OPEN) {
        console.error('[WebSocket] Rejecting new connection - already connected');
        ws.close(1008, 'Another client is already connected');
        return;
      }

      console.error(`[WebSocket] Browser extension connected`);
      this.extensionWs = ws;
      this.emit('connected');

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleExtensionMessage(message);
        } catch (error) {
          console.error('[WebSocket] Error parsing message:', error);
        }
      });

      ws.on('close', () => {
        console.error('[WebSocket] Browser extension disconnected');
        if (this.extensionWs === ws) {
          this.extensionWs = null;
        }
        this.emit('disconnected');
      });

      ws.on('error', (error) => {
        console.error('[WebSocket] Error:', error);
      });
    });

    this.wss.on('listening', () => {
      console.error(`[WebSocket] Server listening on port ${this.port}`);
      this.emit('listening');
    });

    this.wss.on('error', (error) => {
      console.error('[WebSocket] Server error:', error);
    });
  }

  private handleExtensionMessage(message: any) {
    // Forward task-response for tool invocations
    if (message.command === 'task-response') {
      this.emit('task-response', message);
    }
    
    // Send MCP progress notifications for task-update messages
    if (message.command === 'task-update') {
      this.emit('task-update', message);
    }
  }

  public async invokeTool(request: BrowserAgentRequest): Promise<BrowserAgentResponse> {
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
      return {
        error: 'Browser extension not connected. Please ensure the Chrome extension is running and connected to the WebSocket server.'
      };
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ error: 'Tool invocation timeout after 300 seconds' });
      }, 300000); // 5 minutes timeout

      const responseHandler = (response: any) => {
        clearTimeout(timeout);
        this.removeListener('task-response', responseHandler);
        
        // Extension responds with: { command: 'task-response', ...result }
        // where result is the return value from callAction
        if (response.error) {
          resolve({ error: response.message || response.error });
        } else {
          // The response has the action result merged in
          const { command, ...result } = response;
          resolve({ result });
        }
      };

      this.on('task-response', responseHandler);

      // Send request to extension in the format it expects: { name, args }
      this.extensionWs!.send(JSON.stringify({
        command: 'task-request',
        name: request.name,
        args: request.args
      }));
    });
  }

  public isConnected(): boolean {
    return this.extensionWs !== null && this.extensionWs.readyState === WebSocket.OPEN;
  }

  public setProgressToken(token: string | null) {
    this.progressToken = token;
    this.progressCount = 0;
  }

  public sendProgressNotification(message: string) {
    if (!this.progressToken) return null;
    
    this.progressCount++;
    const notification = {
      method: 'notifications/progress',
      params: {
        progressToken: this.progressToken,
        progress: this.progressCount,
        total: undefined,
        message,
      },
    };
    this.emit('notification', notification);
    return notification;
  }

  public sendCancellation() {
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
      return;
    }
    this.extensionWs.send(JSON.stringify({ command: 'task-cancellation' }));
  }

  public close() {
    this.wss.close();
  }
}

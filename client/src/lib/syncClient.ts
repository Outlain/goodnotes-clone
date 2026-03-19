import type { Annotation } from "../types";

// ── Message types ────────────────────────────────────────

interface ConnectedMessage {
  type: "connected";
  clientId: string;
}

interface AnnotationUpdateMessage {
  type: "annotationUpdate";
  pageId: string;
  annotations: Annotation[];
  annotationText: string;
  senderId: string;
}

interface DocumentChangedMessage {
  type: "documentChanged";
  documentId: string;
  senderId: string;
}

type IncomingMessage = ConnectedMessage | AnnotationUpdateMessage | DocumentChangedMessage;

export interface SyncCallbacks {
  onAnnotationUpdate: (pageId: string, annotations: Annotation[], annotationText: string) => void;
  onDocumentChanged: (documentId: string) => void;
}

// ── SyncClient ───────────────────────────────────────────

export class SyncClient {
  private ws: WebSocket | null = null;
  private clientId = "";
  private documentId: string;
  private callbacks: SyncCallbacks;
  private reconnectTimer: number | null = null;
  private disposed = false;

  constructor(documentId: string, callbacks: SyncCallbacks) {
    this.documentId = documentId;
    this.callbacks = callbacks;
    this.connect();
  }

  getClientId(): string {
    return this.clientId;
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.disposed) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws`;

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.send({ type: "subscribe", documentId: this.documentId });
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as IncomingMessage;
        this.handleMessage(message);
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  private handleMessage(message: IncomingMessage): void {
    switch (message.type) {
      case "connected":
        this.clientId = message.clientId;
        break;

      case "annotationUpdate":
        if (message.senderId !== this.clientId) {
          this.callbacks.onAnnotationUpdate(
            message.pageId,
            message.annotations,
            message.annotationText
          );
        }
        break;

      case "documentChanged":
        if (message.senderId !== this.clientId) {
          this.callbacks.onDocumentChanged(message.documentId);
        }
        break;
    }
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}

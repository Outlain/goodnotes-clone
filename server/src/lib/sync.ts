import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import type { Annotation } from "./db.js";

// ── Message types ────────────────────────────────────────

export interface AnnotationUpdateMessage {
  type: "annotationUpdate";
  documentId: string;
  pageId: string;
  annotations: Annotation[];
  annotationText: string;
  senderId: string;
}

export interface DocumentChangedMessage {
  type: "documentChanged";
  documentId: string;
  senderId: string;
}

export interface SubscribeMessage {
  type: "subscribe";
  documentId: string;
}

export interface UnsubscribeMessage {
  type: "unsubscribe";
  documentId: string;
}

type IncomingMessage = AnnotationUpdateMessage | DocumentChangedMessage | SubscribeMessage | UnsubscribeMessage;

interface OutgoingAnnotationUpdate {
  type: "annotationUpdate";
  pageId: string;
  annotations: Annotation[];
  annotationText: string;
  senderId: string;
}

interface OutgoingDocumentChanged {
  type: "documentChanged";
  documentId: string;
  senderId: string;
}

type OutgoingMessage = OutgoingAnnotationUpdate | OutgoingDocumentChanged;

// ── Connection tracking ──────────────────────────────────

interface ConnectedClient {
  ws: WebSocket;
  id: string;
  subscribedDocuments: Set<string>;
}

let clientCounter = 0;
const clients = new Map<WebSocket, ConnectedClient>();

// ── Public API ───────────────────────────────────────────

export function setupWebSocketServer(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    clientCounter += 1;
    const clientId = `c${clientCounter.toString(36)}-${Date.now().toString(36)}`;

    const client: ConnectedClient = {
      ws,
      id: clientId,
      subscribedDocuments: new Set()
    };
    clients.set(ws, client);

    // Send the client its assigned ID
    ws.send(JSON.stringify({ type: "connected", clientId }));

    ws.on("message", (rawData) => {
      try {
        const message = JSON.parse(String(rawData)) as IncomingMessage;
        handleMessage(client, message);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", () => {
      clients.delete(ws);
    });
  });

  return wss;
}

/**
 * Broadcast an annotation update to all clients subscribed to a document,
 * except the sender.  Called from the HTTP annotation save routes so that
 * changes are pushed to other connected clients immediately after the DB
 * write succeeds.
 */
export function broadcastAnnotationUpdate(
  documentId: string,
  pageId: string,
  annotations: Annotation[],
  annotationText: string,
  senderId: string
): void {
  const message: OutgoingAnnotationUpdate = {
    type: "annotationUpdate",
    pageId,
    annotations,
    annotationText,
    senderId
  };

  const payload = JSON.stringify(message);
  broadcast(documentId, payload, senderId);
}

/**
 * Broadcast a structural document change (page insert/delete/rename) so
 * other clients can reload.
 */
export function broadcastDocumentChanged(documentId: string, senderId: string): void {
  const message: OutgoingDocumentChanged = {
    type: "documentChanged",
    documentId,
    senderId
  };

  const payload = JSON.stringify(message);
  broadcast(documentId, payload, senderId);
}

// ── Internal helpers ─────────────────────────────────────

function handleMessage(client: ConnectedClient, message: IncomingMessage): void {
  switch (message.type) {
    case "subscribe":
      client.subscribedDocuments.add(message.documentId);
      break;

    case "unsubscribe":
      client.subscribedDocuments.delete(message.documentId);
      break;

    case "annotationUpdate":
      // Client-to-client relay: when a client sends an annotation update via
      // WebSocket (instead of HTTP), we broadcast it to other clients.
      broadcastAnnotationUpdate(
        message.documentId,
        message.pageId,
        message.annotations,
        message.annotationText,
        client.id
      );
      break;

    case "documentChanged":
      broadcastDocumentChanged(message.documentId, client.id);
      break;
  }
}

function broadcast(documentId: string, payload: string, excludeSenderId: string): void {
  for (const client of clients.values()) {
    if (client.id === excludeSenderId) {
      continue;
    }
    if (!client.subscribedDocuments.has(documentId)) {
      continue;
    }
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

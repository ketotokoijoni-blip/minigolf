import type { ServerMessage } from '@puttipeli/shared/protocol/messages';

export interface Connection {
  readonly id: string;
  readonly remoteAddress: string;
  readonly isOpen: boolean;
  send(msg: ServerMessage): void;          // serializes JSON; silently drops if closed
  close(code?: number, reason?: string): void;
}
export interface ConnectionHandler {
  onOpen(conn: Connection): void;
  onMessage(conn: Connection, raw: string): void; // raw text frame (binary frames are rejected by the transport)
  onClose(conn: Connection): void;
}
export interface Transport {
  start(handler: ConnectionHandler): void;
  stop(): Promise<void>;                   // closes all connections
  connectionCount(): number;
}

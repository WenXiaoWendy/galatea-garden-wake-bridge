import { createServer, type Server, type ServerResponse } from "node:http";
import { GARDEN_PROTOCOL, type WakeReason } from "../../src/protocol.js";

export interface TestSseConnection {
  sendConnected(): void;
  sendWake(reason: WakeReason, message: string): void;
  sendComment(comment?: string): void;
  writeRaw(chunk: string): void;
  close(): void;
}

export interface TestGardenServerOptions {
  hostname?: string;
  port?: number;
  machineToken?: string;
  onConnection?: (connection: TestSseConnection) => void;
}

export interface RunningTestGardenServer {
  baseUrl: URL;
  close(): Promise<void>;
}

function writeEvent(response: ServerResponse, event: string, payload: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function listen(server: Server, port: number, hostname: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

export async function startTestGardenServer(
  options: TestGardenServerOptions = {},
): Promise<RunningTestGardenServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;
  const machineToken = options.machineToken ?? "test-machine-token";
  const clients = new Set<ServerResponse>();

  const server = createServer((request, response) => {
    if (request.url !== GARDEN_PROTOCOL.streamPath || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${machineToken}`) {
      response.writeHead(401).end();
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    response.flushHeaders();
    clients.add(response);
    response.once("close", () => clients.delete(response));

    const connection: TestSseConnection = {
      sendConnected: () =>
        writeEvent(response, GARDEN_PROTOCOL.events.connected, {
          version: GARDEN_PROTOCOL.version,
        }),
      sendWake: (reason, message) =>
        writeEvent(response, GARDEN_PROTOCOL.events.wake, { reason, message }),
      sendComment: (comment = "ping") => response.write(`: ${comment}\n\n`),
      writeRaw: (chunk) => response.write(chunk),
      close: () => response.end(),
    };

    options.onConnection?.(connection);
  });

  await listen(server, port, hostname);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test Garden server did not expose a TCP address");
  }

  return {
    baseUrl: new URL(`http://${hostname}:${address.port}`),
    close: async () => {
      for (const client of clients) {
        client.end();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

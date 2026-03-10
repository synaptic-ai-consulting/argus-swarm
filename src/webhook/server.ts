import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import type { WebhookPayload } from "../api/types.js";

export interface WebhookHandler {
  (payload: WebhookPayload): void | Promise<void>;
}

export function createWebhookServer(
  path: string,
  secret: string | undefined,
  handler: WebhookHandler
) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== path) {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks);
    const signature = req.headers["x-webhook-signature"] as string | undefined;

    if (secret && signature) {
      const expected =
        "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
      if (signature !== expected) {
        res.writeHead(401);
        res.end("Invalid signature");
        return;
      }
    }

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString()) as WebhookPayload;
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }

    res.writeHead(200);
    res.end();

    setImmediate(() => handler(payload));
  });
}

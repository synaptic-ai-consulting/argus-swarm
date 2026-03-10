import localtunnel from "localtunnel";
import { createWebhookServer } from "./server.js";
import { handleStatusChange } from "./handler.js";

const WEBHOOK_PATH = "/webhook/cursor-agent";
const DEFAULT_PORT = 3847;

export interface EmbeddedWebhookResult {
  webhookUrl: string;
  close: () => Promise<void>;
}

/**
 * Start an embedded webhook server with a public tunnel.
 * Used transparently by `argus run` when no webhook URL is configured.
 */
export async function startEmbeddedWebhook(
  secret: string | undefined,
  port: number = DEFAULT_PORT
): Promise<EmbeddedWebhookResult> {
  const server = createWebhookServer(
    WEBHOOK_PATH,
    secret,
    (payload) => void handleStatusChange(payload)
  );

  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const tunnel = await localtunnel({ port });
  const webhookUrl = `${tunnel.url.replace(/\/$/, "")}${WEBHOOK_PATH}`;

  const close = async () => {
    tunnel.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  tunnel.on("error", (err: unknown) => {
    console.error("[argus] Tunnel error:", err);
  });

  return { webhookUrl, close };
}

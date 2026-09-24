import { createServer } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { wsHub } from "./lib/ws";
import { startObjectDeletionWorker } from "./lib/object-cleanup";
import { startAccountDeletionWorker } from "./lib/account-deletion";
import { startMessageNotificationWorker } from "./lib/message-notification-delivery";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);
wsHub.attach(server);
server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});
server.listen(port, () => {
  startObjectDeletionWorker();
  startAccountDeletionWorker();
  startMessageNotificationWorker();
  logger.info({ port }, "Server listening");
});

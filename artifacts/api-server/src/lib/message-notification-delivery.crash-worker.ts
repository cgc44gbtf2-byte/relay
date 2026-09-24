import { processMessageNotificationDeliveries } from "./message-notification-delivery";

async function main(): Promise<void> {
  const mode = process.argv[2];
  const result = await processMessageNotificationDeliveries({
    batchSize: 1,
    ...(mode === "pause-after-commit"
      ? {
        afterCommitBeforeBroadcast: async () => {
          process.stdout.write("committed-before-broadcast\n");
          await new Promise<void>(() => {});
        },
      }
      : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
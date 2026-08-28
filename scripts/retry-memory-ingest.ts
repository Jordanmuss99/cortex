import "dotenv/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

interface RetryArguments {
  agent: string;
  event: string;
}

class UsageError extends Error {}
class IneligibleEventError extends Error {}

function parseArguments(values: readonly string[]): RetryArguments {
  if (values.length !== 4) throw new UsageError();
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (
      !new Set(["--agent", "--event"]).has(flag) ||
      parsed.has(flag) ||
      !value
    ) {
      throw new UsageError();
    }
    parsed.set(flag, value);
  }
  const agent = parsed.get("--agent") ?? "";
  const event = parsed.get("--event") ?? "";
  if (
    agent !== agent.trim() ||
    agent.length < 1 ||
    agent.length > 64 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      event
    )
  ) {
    throw new UsageError();
  }
  return { agent, event: event.toLowerCase() };
}

export async function retryMemoryIngest(
  args: readonly string[] = process.argv.slice(2)
): Promise<void> {
  let closeDatabaseConnection: (() => Promise<void>) | undefined;
  let parsed: RetryArguments;
  try {
    parsed = parseArguments(args);
  } catch {
    console.error(
      "Usage: memory:retry-ingest -- --agent <external-agent-id> --event <uuid>"
    );
    process.exitCode = 2;
    return;
  }

  try {
    const database = await import("../src/db/index.js");
    const [{ createIngestService }, { createMemoryServiceDependencies }] =
      await Promise.all([
        import("../src/memory/ingest.js"),
        import("../src/memory/index.js"),
      ]);
    closeDatabaseConnection = database.closeDatabaseConnection;
    const { initDatabase } = database;
    await initDatabase();
    const dependencies = createMemoryServiceDependencies();
    const agents = await dependencies.sql`
      SELECT id
      FROM public.agents
      WHERE external_id = ${parsed.agent}
      LIMIT 1
    `;
    if (!agents[0]) throw new IneligibleEventError();

    const receipt = await createIngestService(
      dependencies
    ).retryTerminalFailure(Number(agents[0].id), parsed.event);
    if (!receipt) throw new IneligibleEventError();

    process.stdout.write(
      `${JSON.stringify({
        agent: parsed.agent,
        eventId: receipt.eventId,
        status: receipt.status,
        manualRetryCount: receipt.manualRetryCount,
        totalAttempts: receipt.totalAttempts,
        acceptedAt: receipt.acceptedAt,
      })}\n`
    );
  } catch (error) {
    if (error instanceof IneligibleEventError) {
      console.error("The event was not found or is not eligible for retry");
      process.exitCode = 3;
      return;
    }
    console.error("Memory ingest retry failed", { code: "retry_failed" });
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection?.().catch(() => {});
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await retryMemoryIngest();
}

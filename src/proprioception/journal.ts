/**
 * CORTEX V2 — Proprioception: Agent Journal
 *
 * Structured self-state logging for agent introspection.
 */
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import { createMemoryServiceDependencies } from "../memory/index.js";
import { reconcileJournalInTransaction } from "../memory/working-set.js";
import type {
  MemoryServiceDependencies,
  WorkingItem,
} from "../memory/types.js";

export interface JournalEntry {
  energyState?: "high" | "normal" | "low" | "depleted";
  activeThreads?: unknown[];
  confidence?: number;
  memoryQuality?: number;
  concerns?: string[];
  notes?: string;
  sessionId?: string;
  resolvedCallerKeys?: string[];
}

export interface JournalWriteResult {
  journalId: number;
  workingItems: WorkingItem[];
}

const defaultJournalDependencies = createMemoryServiceDependencies();

export async function writeJournalEntry(
  agentId: number,
  entry: JournalEntry,
  deps: MemoryServiceDependencies = defaultJournalDependencies
): Promise<JournalWriteResult> {
  const activeThreads = entry.activeThreads ?? [];
  const concerns = entry.concerns ?? [];
  const now = deps.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Journal clock must return a valid instant");
  }
  const timestamp = now.toISOString();

  return deps.sql.begin(async (transaction) => {
    const serializedThreads = JSON.stringify(activeThreads);
    const inserted = (await transaction`
      INSERT INTO public.agent_state_logs (
        agent_id,
        timestamp,
        session_id,
        energy_state,
        active_threads,
        confidence,
        memory_quality,
        concerns,
        notes
      ) VALUES (
        ${agentId},
        ${timestamp}::timestamptz,
        ${entry.sessionId || null},
        ${entry.energyState || "normal"},
        ${transaction.typed(serializedThreads, 25)}::jsonb,
        ${entry.confidence ?? 0.5},
        ${entry.memoryQuality ?? 0.5},
        ${transaction.array(concerns)}::text[],
        ${entry.notes || null}
      )
      RETURNING id
    `) as unknown as Array<{ id: number | string }>;
    if (inserted.length !== 1) {
      throw new Error("Journal insert did not return one row");
    }

    const workingItems = await reconcileJournalInTransaction(
      deps,
      transaction,
      agentId,
      {
        activeThreads: activeThreads.map(String),
        concerns,
        resolvedCallerKeys: entry.resolvedCallerKeys,
        sessionId: entry.sessionId,
      },
      now
    );

    return {
      journalId: Number(inserted[0].id),
      workingItems,
    };
  });
}

export async function getRecentJournal(agentId: number, hours = 24): Promise<Array<{
  id: number;
  timestamp: Date;
  energyState: string | null;
  confidence: number | null;
  memoryQuality: number | null;
  concerns: string[] | null;
  notes: string | null;
  sessionId: string | null;
}>> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const entries = await db
    .select()
    .from(schema.agentStateLogs)
    .where(eq(schema.agentStateLogs.agentId, agentId))
    .orderBy(desc(schema.agentStateLogs.timestamp))
    .limit(50);

  return entries.filter(e => e.timestamp >= since).map(e => ({
    id: e.id,
    timestamp: e.timestamp,
    energyState: e.energyState,
    confidence: e.confidence,
    memoryQuality: e.memoryQuality,
    concerns: e.concerns,
    notes: e.notes,
    sessionId: e.sessionId,
  }));
}

export function formatJournalEntries(entries: Awaited<ReturnType<typeof getRecentJournal>>): string {
  if (entries.length === 0) return "No journal entries found.\n";

  let output = `# Agent Journal (${entries.length} entries)\n\n`;
  for (const e of entries) {
    const time = e.timestamp.toISOString().replace("T", " ").slice(0, 19);
    output += `## ${time}\n`;
    output += `- Energy: ${e.energyState || "unknown"}\n`;
    output += `- Confidence: ${e.confidence?.toFixed(2) || "?"}\n`;
    output += `- Memory Quality: ${e.memoryQuality?.toFixed(2) || "?"}\n`;
    if (e.concerns && e.concerns.length > 0) output += `- Concerns: ${e.concerns.join(", ")}\n`;
    if (e.notes) output += `- Notes: ${e.notes}\n`;
    output += "\n";
  }
  return output;
}

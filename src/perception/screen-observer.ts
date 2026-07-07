/**
 * CORTEX V2 — Perceptual Integration: Screen Observer
 *
 * Captures the current screen state for contextual awareness and debugging.
 *
 * Windows (primary platform since 2026-06-12): native PowerShell capture of
 * the foreground window title/process plus a full virtual-screen PNG saved
 * under ~/.cortex/observations/. The PNG path is returned so the CALLING
 * agent (which is multimodal) can read the image itself - Cortex does not
 * run a server-side vision pass.
 *
 * macOS (legacy path): Peekaboo / AppleScript window metadata only.
 */
import { db, schema } from "../db/index.js";
import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { extractEntitiesSync as extractEntities, extractSemanticTags } from "../ingestion/entities.js";
import { formSynapses } from "../ingestion/synapse-formation.js";
import { embedTexts } from "../ingestion/embeddings.js";

interface ScreenObservation {
  activeApp: string;
  windowTitle: string;
  description: string;
  entities: string[];
  timestamp: string;
  /** Absolute path of the saved screenshot PNG (Windows), or null. */
  screenshotPath: string | null;
}

function runCommand(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: 20000,
      windowsHide: true,
    }).trim();
  } catch {
    return "";
  }
}

/** PowerShell-quoted single string literal ('' escapes '). */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function captureWindows(): ScreenObservation {
  const obsDir = join(homedir(), ".cortex", "observations");
  try {
    mkdirSync(obsDir, { recursive: true });
  } catch {
    /* best-effort; capture still reports window metadata */
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const outPath = join(obsDir, `observation-${stamp}.png`);

  // One PowerShell pass: foreground window metadata via user32, then a
  // full virtual-screen capture via System.Drawing. $pid is reserved in
  // PowerShell - use $procId.
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$ProgressPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    'Add-Type @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "public class CortexFG {",
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    "}",
    '"@',
    "$h=[CortexFG]::GetForegroundWindow()",
    "$sb=New-Object System.Text.StringBuilder 512",
    "[void][CortexFG]::GetWindowText($h,$sb,512)",
    "$procId=[uint32]0",
    "[void][CortexFG]::GetWindowThreadProcessId($h,[ref]$procId)",
    "$p=Get-Process -Id $procId -ErrorAction SilentlyContinue",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen",
    "$bmp=New-Object System.Drawing.Bitmap $vs.Width,$vs.Height",
    "$g=[System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($vs.Left,$vs.Top,0,0,$bmp.Size)",
    `$bmp.Save(${psQuote(outPath)},[System.Drawing.Imaging.ImageFormat]::Png)`,
    "$g.Dispose()",
    "$bmp.Dispose()",
    'Write-Output ("{0}|{1}" -f $p.ProcessName, $sb.ToString())',
  ].join("\n");

  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const out = runCommand(
    `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
  );

  let activeApp = "Unknown";
  let windowTitle = "Unknown";
  const lastLine = out.split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";
  const sep = lastLine.indexOf("|");
  if (sep >= 0) {
    activeApp = lastLine.slice(0, sep).trim() || "Unknown";
    windowTitle = lastLine.slice(sep + 1).trim() || "Unknown";
  }

  // Only report the screenshot if the file actually landed.
  const screenshotPath: string | null = existsSync(outPath) ? outPath : null;

  const description = `Screen observation: ${activeApp} is active with window "${windowTitle}".${screenshotPath ? ` Full-screen capture saved to ${screenshotPath}.` : " Screen capture failed; window metadata only."}`;

  return {
    activeApp,
    windowTitle,
    description,
    entities: extractEntities(`${activeApp} ${windowTitle} ${description}`),
    timestamp: new Date().toISOString(),
    screenshotPath,
  };
}

function captureMacOS(): ScreenObservation {
  const windowList = runCommand("peekaboo list 2>/dev/null");

  let activeApp = "Unknown";
  let windowTitle = "Unknown";

  if (windowList) {
    const lines = windowList.split("\n").filter((l) => l.trim());
    if (lines.length > 0) {
      const parts = lines[0].split(" - ");
      if (parts.length >= 2) {
        activeApp = parts[0].trim();
        windowTitle = parts.slice(1).join(" - ").trim();
      } else {
        activeApp = lines[0].trim();
      }
    }
  }

  if (activeApp === "Unknown") {
    activeApp =
      runCommand(
        `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null`
      ) || "Unknown";
    windowTitle =
      runCommand(
        `osascript -e 'tell application "System Events" to get name of first window of first application process whose frontmost is true' 2>/dev/null`
      ) || "Unknown";
  }

  const description = `Screen observation: ${activeApp} is active with window "${windowTitle}".`;
  return {
    activeApp,
    windowTitle,
    description,
    entities: extractEntities(`${activeApp} ${windowTitle} ${description}`),
    timestamp: new Date().toISOString(),
    screenshotPath: null,
  };
}

export async function captureAndAnalyze(): Promise<ScreenObservation> {
  return process.platform === "win32" ? captureWindows() : captureMacOS();
}

export async function ingestObservation(agentId: number, observation: ScreenObservation): Promise<number[]> {
  const content = `[Screen Observation ${observation.timestamp}] App: ${observation.activeApp}, Window: "${observation.windowTitle}". ${observation.description}`;

  const entities = observation.entities;
  const tags = ["observation", ...extractSemanticTags(content)];
  const embeddings = await embedTexts([content]);

  const [inserted] = await db
    .insert(schema.memoryNodes)
    .values({
      agentId,
      content,
      source: observation.screenshotPath || "screen-observer",
      sourceType: "observation",
      chunkIndex: 0,
      embedding: embeddings[0],
      entities,
      semanticTags: tags,
      priority: 3, // Low priority, ephemeral
      resonanceScore: 3.0,
      status: "active",
    })
    .returning({ id: schema.memoryNodes.id });

  // Form synapses with existing memories
  await formSynapses(agentId, [inserted.id]);

  return [inserted.id];
}

export function formatObservation(observation: ScreenObservation): string {
  let output = `# Screen Observation\n`;
  output += `- Time: ${observation.timestamp}\n`;
  output += `- Active App: ${observation.activeApp}\n`;
  output += `- Window: ${observation.windowTitle}\n`;
  output += `- Description: ${observation.description}\n`;
  if (observation.entities.length > 0) {
    output += `- Entities: ${observation.entities.join(", ")}\n`;
  }
  if (observation.screenshotPath) {
    output += `- Screenshot: ${observation.screenshotPath}\n`;
    output += `\nREAD the screenshot file above with your image/file reading tool to analyze the screen visually - Cortex stores the path, you supply the eyes.\n`;
  }
  return output;
}

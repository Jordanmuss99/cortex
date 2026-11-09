import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The single source for every version string this server reports: the REST root
 * descriptor, the REST health/status bodies, and the MCP server identity handed to
 * clients during initialize.
 *
 * package.json is read by walking upward from this module rather than importing it, so
 * the value is correct when run from `src/` under tsx and from a compiled `dist/` layout,
 * and a release bump can no longer leave an endpoint advertising an old version. If no
 * readable package.json is found (a bundling that strips it), npm's own copy of the value
 * is used, then the current release as a last resort.
 */
export const PACKAGE_VERSION: string = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8"));
        if (typeof parsed?.version === "string" && parsed.version) return parsed.version;
      } catch {
        // Unreadable or malformed: keep walking upward instead of reporting a stale number.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.env.npm_package_version || "2.4.0";
})();

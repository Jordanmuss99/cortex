import "dotenv/config";
import { PACKAGE_VERSION } from "./lib/version.js";
import { initDatabase } from "./db/index.js";
import { createApp } from "./app.js";

const app = createApp();
// CORTEX_API_PORT keeps this server off the dashboard's port: dashboard/server.mjs owns
// 3100 by default, so both can listen at once. A generic PORT still wins when set.
const PORT = parseInt(process.env.CORTEX_API_PORT || process.env.PORT || "4000", 10);


// Start
async function start() {
  try {
    await initDatabase();
    console.log("[cortex] Database connected");
  } catch (err) {
    console.error("[cortex] Database connection failed:", err);
    console.log("[cortex] Starting without database — some endpoints will fail");
  }

  const server = app.listen(PORT, () => {
    console.log(`[cortex] CORTEX V2 ${PACKAGE_VERSION} running on http://localhost:${PORT}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[cortex] Port ${PORT} is already in use. The OmO dashboard listens on 3100 by default; ` +
          "move one of them with CORTEX_API_PORT=<port> (API) or CORTEX_DASHBOARD_PORT=<port> " +
          "(dashboard, or --port)."
      );
    } else {
      console.error("[cortex] Listen failed:", err.message);
    }
    process.exit(1);
  });
}

start();

export default app;

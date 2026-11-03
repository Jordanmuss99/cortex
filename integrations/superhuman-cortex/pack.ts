import * as sdk from "@codahq/packs-sdk";

// Superhuman Go connector for the CORTEX read-only memory MCP endpoint.
// Backend: cortex/src/mcp/http-server.ts (POST /mcp) — exposes ONLY
// cortex_search, cortex_recall, cortex_init, all annotated readOnlyHint:true.
//
// Deployment fork (cortex/docs/superhuman-go-mcp-integration-plan.md §7.4):
//   * Preferred: Cortex is HOSTED (Vercel + Neon). Point endpointUrl at the Vercel URL
//     + "/mcp"; no Cloudflare tunnel is needed for cortex.
//   * Alternate: if you instead run Cortex on the tunnel host, use the named-tunnel
//     hostname below and route it to the local Cortex port.
//
// Scaffold only — DO NOT release until the §7.5 go-live gate passes (the /mcp transport
// is proven — done — and a real Cortex token is set via CORTEX_MCP_TOKEN).
export const pack = sdk.newPack();

pack.addMCPServer({
  name: "Cortex",
  // TODO: replace with the released Cortex host once deployed (Vercel or tunnel).
  endpointUrl: "https://cortex.obsidiannetwork.au/mcp",
  searchToolNames: ["cortex_search", "cortex_recall"],
});

// http-server.ts checks `Authorization: Bearer <CORTEX_MCP_TOKEN>`; fails closed if unset.
pack.setUserAuthentication({
  type: sdk.AuthenticationType.HeaderBearerToken,
  instructionsUrl: "https://github.com/your-org/cortex#superhuman-go",
});

pack.addNetworkDomain("obsidiannetwork.au");

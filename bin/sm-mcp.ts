#!/usr/bin/env -S npx tsx
/**
 * sm-mcp — MCP server entry point.
 *
 * Starts an MCP server that bridges AI clients to the secrets-manager daemon
 * over stdin/stdout (the standard MCP transport for local servers).
 *
 * Usage:
 *   tsx bin/sm-mcp.ts [--socket PATH]
 *
 * The --socket flag overrides the default daemon socket path so that the MCP
 * server can talk to a specific running daemon instance (useful in tests).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createMcpServer } from "../mcp/server";
import { callTool } from "../mcp/tools/index";
import { socketPath as defaultSocketPath } from "../lib/daemon/paths";

// ---------------------------------------------------------------------------
// Parse --socket flag from argv.
// ---------------------------------------------------------------------------
function parseSocketPath(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--socket");
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return defaultSocketPath();
}

async function main(): Promise<void> {
  const daemonSocketPath = parseSocketPath();

  const { server, toolDefs } = createMcpServer({ socketPath: daemonSocketPath });

  // Register the tools/list handler.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefs,
  }));

  // Register the tools/call handler.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const result = await callTool(
      name,
      args as Record<string, unknown>,
      { socketPath: daemonSocketPath },
    );
    return result;
  });

  // Connect via stdio transport (standard for local MCP servers).
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep the process alive — MCP servers run as long as the transport is open.
  // The transport emits 'close' when stdin closes (client disconnects).
}

main().catch((e) => {
  process.stderr.write(`sm-mcp fatal: ${(e as Error).message ?? e}\n`);
  process.exit(1);
});

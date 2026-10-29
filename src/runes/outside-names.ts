// Pretty names and rune kinds for rollout rows that name a built-in tool, not a file (Auto set rows).
// Keyed by the row's path with its agent namespace prefix dropped, lowercased.
export const OUTSIDE_TOOLS: Readonly<Record<string, { name: string; kind: string }>> = {
  list_mcp_resources: { name: "List MCP Resources", kind: "mcp" },
  list_mcp_resource_templates: { name: "List MCP Resource Templates", kind: "mcp" },
};

export const outsideTool = (path: string): { name: string; kind: string } | undefined =>
  Object.hasOwn(OUTSIDE_TOOLS, path.toLowerCase().replace(/^[a-z]+\./, ""))
    ? OUTSIDE_TOOLS[path.toLowerCase().replace(/^[a-z]+\./, "")] : undefined;

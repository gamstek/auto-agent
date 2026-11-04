/** Application packaging registry; these programs run independently of the Agent. */
const programs: Record<string, () => Promise<void>> = {
  climber: async () => {
    const { serveClimber } = await import('@auto-agent/climber-mcp/server');
    await serveClimber();
  },
};
export async function serveBundledMcp(name: string) {
  if (!Object.hasOwn(programs, name)) throw new Error('Unknown bundled MCP server');
  await programs[name]!();
}

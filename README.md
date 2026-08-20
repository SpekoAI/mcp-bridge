# @spekoai/mcp

Configure coding agents to connect directly to Speko's hosted MCP server over
HTTP. Version 2 removes the local stdio bridge: modern clients connect to
`https://mcp.speko.ai/mcp` with OAuth browser sign-in or `SPEKO_API_KEY`.

## Install

Run the setup wizard and choose OAuth for interactive use:

```bash
npx @spekoai/mcp@latest init
```

For automation, create a Platform API key in the Speko dashboard and choose
API-key authentication.

The wizard detects Claude Code, Claude Desktop, Codex, OpenCode, Cursor,
Windsurf, VS Code, Gemini CLI, Cline, and Zed. It writes each client's direct
HTTP configuration and preserves existing JSON, JSONC, and TOML settings.

For scripted setup, pass every choice explicitly:

```bash
npx @spekoai/mcp@latest init --auth oauth --tools all --scope user --yes
SPEKO_API_KEY=sk_live_xxx npx @spekoai/mcp@latest init --auth api-key --tools claude,cursor,codex --scope project --yes
```

Use `--dry-run` to print the proposed edits without changing files. Run
`npx @spekoai/mcp@latest --help` for the complete option list.

## Gateway key management

The `gateway.keys.list`, `gateway.keys.create`, and `gateway.keys.revoke` tools
require a Platform API key created by an organization owner or admin with
**Manage Gateway API keys** enabled. Other MCP tools work with an ordinary
unscoped Platform API key.

Speko MCP is stateless for both authentication modes. Better Auth owns the
OAuth flow; the MCP service stores no clients, codes, refresh tokens, or local
credential cache. Gateway key tools currently require API-key auth.

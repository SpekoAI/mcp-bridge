#!/usr/bin/env node

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const DEFAULT_AUTH_MCP_URL = 'https://mcp.speko.ai/mcp-auth';
export const DEFAULT_PUBLIC_MCP_URL = 'https://mcp.speko.ai/mcp';
export const AUTH_HEADER_ENV = 'SPEKOAI_MCP_AUTH_HEADER';

export type Environment = Record<string, string | undefined>;

export type CliConfig = {
  serverUrl: string;
  passthroughArgs: string[];
  publicOnly: boolean;
  help: boolean;
};

export type AuthHeaderConfig = {
  args: string[];
  envValue?: string;
};

export const HELP_TEXT = `Usage: spekoai-mcp [url] [mcp-remote flags]

Bridge local stdio MCP clients to SpekoAI's hosted MCP server.

Defaults:
  Authenticated endpoint: ${DEFAULT_AUTH_MCP_URL}
  Public-only endpoint:   ${DEFAULT_PUBLIC_MCP_URL}

Options:
  --public       Connect to the public docs/scaffolding endpoint.
  -h, --help     Print this help text.

Environment:
  SPEKOAI_MCP_AUTH_URL   Override the authenticated endpoint.
  SPEKOAI_MCP_URL        Override the public endpoint.
  SPEKO_API_KEY          Forward as Authorization bearer token.

Examples:
  spekoai-mcp
  spekoai-mcp --public
  SPEKO_API_KEY=sk_live_xxx spekoai-mcp
  SPEKOAI_MCP_AUTH_URL=https://mcp-staging.speko.dev/mcp-auth spekoai-mcp
  spekoai-mcp https://mcp-staging.speko.dev/mcp-auth --debug

All remaining arguments are passed through to mcp-remote.
`;

export function resolveCliConfig(
  argv: readonly string[],
  env: Environment = process.env,
): CliConfig {
  const help = argv.includes('--help') || argv.includes('-h');
  const withoutPublicFlag = argv.filter((arg) => arg !== '--public');
  const publicOnly = withoutPublicFlag.length !== argv.length;
  const first = withoutPublicFlag[0];
  const hasExplicitUrl = isHttpUrl(first);

  if (hasExplicitUrl) {
    return {
      serverUrl: first,
      passthroughArgs: withoutPublicFlag.slice(1),
      publicOnly,
      help,
    };
  }

  return {
    serverUrl: publicOnly
      ? envUrl(env.SPEKOAI_MCP_URL, DEFAULT_PUBLIC_MCP_URL)
      : envUrl(env.SPEKOAI_MCP_AUTH_URL, DEFAULT_AUTH_MCP_URL),
    passthroughArgs: withoutPublicFlag,
    publicOnly,
    help,
  };
}

export function buildAuthHeaderArgs(env: Environment = process.env): AuthHeaderConfig {
  const apiKey = env.SPEKO_API_KEY?.trim();
  if (!apiKey) {
    return { args: [] };
  }

  return {
    args: ['--header', `Authorization:\${${AUTH_HEADER_ENV}}`],
    envValue: `Bearer ${apiKey}`,
  };
}

export function buildProxyArgv(options: {
  nodePath: string;
  proxyPath: string;
  serverUrl: string;
  authArgs: readonly string[];
  passthroughArgs: readonly string[];
}): string[] {
  return [
    options.nodePath,
    options.proxyPath,
    options.serverUrl,
    ...options.authArgs,
    ...options.passthroughArgs,
  ];
}

export function resolveProxyPath(): string {
  return createRequire(import.meta.url).resolve('mcp-remote/dist/proxy.js');
}

export async function run(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const config = resolveCliConfig(argv, env);
  if (config.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const auth = buildAuthHeaderArgs(env);
  if (auth.envValue) {
    env[AUTH_HEADER_ENV] = auth.envValue;
  } else {
    delete env[AUTH_HEADER_ENV];
  }

  const proxyPath = resolveProxyPath();
  process.argv = buildProxyArgv({
    nodePath: process.execPath,
    proxyPath,
    serverUrl: config.serverUrl,
    authArgs: auth.args,
    passthroughArgs: config.passthroughArgs,
  });
  await import(pathToFileURL(proxyPath).href);
}

function envUrl(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function isHttpUrl(value: string | undefined): value is string {
  return value?.startsWith('https://') === true || value?.startsWith('http://') === true;
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

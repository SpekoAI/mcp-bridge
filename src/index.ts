#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AUTH_HEADER_ENV, DEFAULT_AUTH_MCP_URL, type Environment } from './constants.js';
import { runInitCommand } from './init.js';

export type { DetectCtx } from './detect.js';
export {
  claudeDesktopConfigPath,
  clineSettingsPath,
  detectInstalledTools,
  realDetectCtx,
  vscodeUserDir,
  windsurfDir,
  zedSettingsPath,
} from './detect.js';
export {
  GUIDANCE_BEGIN,
  GUIDANCE_CARD,
  GUIDANCE_END,
  standaloneGuidanceContent,
  upsertGuidanceBlock,
} from './guidance.js';
export type {
  InitAuth,
  InitScope,
  InitTool,
  ParsedInitArgs,
  PlannedInitStep,
  ResolvedInitOptions,
} from './init.js';
export {
  bridgeServerEntry,
  buildBridgeMcpServersConfig,
  buildCodexConfig,
  buildCursorConfig,
  buildInitPlan,
  buildOpenCodeConfig,
  buildVsCodeConfig,
  completeInitArgs,
  DEFAULT_SCOPE,
  DEFAULT_SELECTED_TOOLS,
  INIT_HELP_TEXT,
  parseInitArgs,
  runInitCommand,
} from './init.js';
export type { Environment };
export { AUTH_HEADER_ENV, DEFAULT_AUTH_MCP_URL };

export type CliConfig = {
  serverUrl: string;
  passthroughArgs: string[];
  help: boolean;
};

export type AuthHeaderConfig = {
  args: string[];
  envValue?: string;
};

export const HELP_TEXT = `Usage: spekoai-mcp <command> [options]

Configure Speko MCP in coding tools, or run the local stdio bridge for MCP clients that cannot connect to remote HTTP MCP directly.

Commands:
  init          Configure Speko MCP in coding tools.
  bridge        Run the local stdio bridge to Speko's hosted MCP server.

Options:
  -h, --help    Print this help text.

Examples:
  spekoai-mcp init
  spekoai-mcp init --dry-run --auth oauth --tools cursor --scope project --yes
  spekoai-mcp bridge
`;

export const BRIDGE_HELP_TEXT = `Usage: spekoai-mcp bridge [options] [mcp-remote flags]

Bridge local stdio MCP clients to Speko's hosted MCP server.

Defaults:
  Speko MCP endpoint: ${DEFAULT_AUTH_MCP_URL}

Options:
  -h, --help   Print this help text.

Environment:
  SPEKO_API_KEY   Forward as Authorization bearer token.

Examples:
  spekoai-mcp bridge
  SPEKO_API_KEY=sk_live_xxx spekoai-mcp bridge

All remaining arguments are passed through to mcp-remote.
`;

export function resolveCliConfig(
  argv: readonly string[],
  env: Environment = process.env,
): CliConfig {
  const help = argv.includes('--help') || argv.includes('-h');
  const first = argv[0];
  const hasExplicitUrl = isHttpUrl(first);

  if (hasExplicitUrl) {
    return {
      serverUrl: first,
      passthroughArgs: argv.slice(1),
      help,
    };
  }

  return {
    serverUrl: envUrl(env.SPEKOAI_MCP_URL, DEFAULT_AUTH_MCP_URL),
    passthroughArgs: [...argv],
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

export function isCliEntrypoint(
  entrypointPath = process.argv[1],
  moduleUrl = import.meta.url,
): boolean {
  if (!entrypointPath) {
    return false;
  }

  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(entrypointPath) === realpathSync(modulePath);
  } catch {
    return pathToFileURL(entrypointPath).href === moduleUrl;
  }
}

export async function run(argv = process.argv.slice(2), env = process.env): Promise<void> {
  if (argv[0] === 'init') {
    await runInitCommand(argv.slice(1), { env });
    return;
  }

  if (argv[0] === 'bridge') {
    await runBridgeCommand(argv.slice(1), env);
    return;
  }

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  throw new Error(`Unknown command: ${argv[0]}. Run "spekoai-mcp --help" for usage.`);
}

async function runBridgeCommand(argv: readonly string[], env: Environment): Promise<void> {
  const config = resolveCliConfig(argv, env);
  if (config.help) {
    process.stdout.write(BRIDGE_HELP_TEXT);
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

if (isCliEntrypoint()) {
  run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

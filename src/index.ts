#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_AUTH_MCP_URL, type Environment } from './constants.js';
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
  buildCodexConfig,
  buildCursorConfig,
  buildHttpMcpServersConfig,
  buildInitPlan,
  buildOpenCodeConfig,
  buildVsCodeConfig,
  completeInitArgs,
  DEFAULT_SCOPE,
  DEFAULT_SELECTED_TOOLS,
  httpServerEntry,
  INIT_HELP_TEXT,
  isApiKeyAuth,
  parseInitArgs,
  runInitCommand,
} from './init.js';
export type { Environment };
export { DEFAULT_AUTH_MCP_URL };

export const HELP_TEXT = `Usage: spekoai-mcp <command> [options]

Configure direct HTTP OAuth or API-key access to Speko MCP in coding tools.

Commands:
  init          Configure Speko MCP with OAuth or SPEKO_API_KEY.

Options:
  -h, --help    Print this help text.

Examples:
  spekoai-mcp init
  spekoai-mcp init --dry-run --tools cursor --scope project --yes
`;

export function isCliEntrypoint(
  entrypointPath = process.argv[1],
  moduleUrl = import.meta.url,
): boolean {
  if (!entrypointPath) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(entrypointPath) === realpathSync(modulePath);
  } catch {
    return pathToFileURL(entrypointPath).href === moduleUrl;
  }
}

export async function run(argv = process.argv.slice(2), env: Environment = process.env) {
  if (argv[0] === 'init') {
    await runInitCommand(argv.slice(1), { env });
    return;
  }
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  throw new Error(`Unknown command: ${argv[0]}. Run "spekoai-mcp --help" for usage.`);
}

if (isCliEntrypoint()) {
  run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

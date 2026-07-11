/**
 * Coding-agent detection + per-agent config paths for `spekoai-mcp init`.
 *
 * Detection is deliberately conservative: an agent counts as installed when its
 * well-known config directory exists or its CLI answers `--version`. Every
 * probe is injectable so tests never touch the real machine (same discipline
 * as the plan/apply engine in init.ts). Path knowledge lives here in exactly
 * one place, because vendor paths drift.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Environment } from './constants.js';
import type { InitTool } from './init.js';

export interface DetectCtx {
  homeDir: string;
  platform: NodeJS.Platform;
  env: Environment;
  /** `existsSync` probe — injectable for tests. */
  exists(path: string): boolean;
  /** `spawnSync(cmd, ["--version"])` probe — injectable for tests. */
  hasCli(cmd: string): boolean;
}

/** Production context: real HOME/platform/filesystem/CLIs. Tests build their own. */
export function realDetectCtx(homeDir: string, env: Environment): DetectCtx {
  return {
    homeDir,
    platform: process.platform,
    env,
    exists: (path) => existsSync(path),
    hasCli(cmd) {
      try {
        return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
      } catch {
        return false;
      }
    },
  };
}

/** VS Code's per-user config dir (also the parent of extension globalStorage). */
export function vscodeUserDir(ctx: Pick<DetectCtx, 'homeDir' | 'platform' | 'env'>): string {
  if (ctx.platform === 'darwin') {
    return join(ctx.homeDir, 'Library', 'Application Support', 'Code', 'User');
  }
  if (ctx.platform === 'win32') {
    return join(ctx.env.APPDATA ?? join(ctx.homeDir, 'AppData', 'Roaming'), 'Code', 'User');
  }
  return join(ctx.homeDir, '.config', 'Code', 'User');
}

/** Claude Desktop's config file — per platform. */
export function claudeDesktopConfigPath(
  ctx: Pick<DetectCtx, 'homeDir' | 'platform' | 'env'>,
): string {
  if (ctx.platform === 'darwin') {
    return join(
      ctx.homeDir,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  }
  if (ctx.platform === 'win32') {
    return join(
      ctx.env.APPDATA ?? join(ctx.homeDir, 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json',
    );
  }
  return join(ctx.homeDir, '.config', 'Claude', 'claude_desktop_config.json');
}

/** Cline (VS Code extension) MCP settings file — exists only once the extension has run. */
export function clineSettingsPath(ctx: Pick<DetectCtx, 'homeDir' | 'platform' | 'env'>): string {
  return join(
    vscodeUserDir(ctx),
    'globalStorage',
    'saoudrizwan.claude-dev',
    'settings',
    'cline_mcp_settings.json',
  );
}

/** Zed's settings file — per platform. */
export function zedSettingsPath(ctx: Pick<DetectCtx, 'homeDir' | 'platform' | 'env'>): string {
  if (ctx.platform === 'win32') {
    return join(ctx.env.APPDATA ?? join(ctx.homeDir, 'AppData', 'Roaming'), 'Zed', 'settings.json');
  }
  return join(ctx.homeDir, '.config', 'zed', 'settings.json');
}

/** Windsurf's per-user config dir. */
export function windsurfDir(ctx: Pick<DetectCtx, 'homeDir'>): string {
  return join(ctx.homeDir, '.codeium', 'windsurf');
}

/**
 * Which supported tools look installed on this machine, in TOOL_SPECS order.
 * `other` is never auto-detected — it exists for clients we don't know.
 */
export function detectInstalledTools(ctx: DetectCtx): InitTool[] {
  const home = ctx.homeDir;
  const detected: InitTool[] = [];

  if (ctx.hasCli('claude')) detected.push('claude');
  if (ctx.exists(claudeDesktopConfigPath(ctx))) detected.push('claude-desktop');
  if (ctx.exists(join(home, '.codex')) || ctx.hasCli('codex')) detected.push('codex');
  if (ctx.exists(join(home, '.config', 'opencode')) || ctx.hasCli('opencode')) {
    detected.push('opencode');
  }
  if (ctx.exists(join(home, '.cursor'))) detected.push('cursor');
  if (ctx.exists(windsurfDir(ctx))) detected.push('windsurf');
  if (ctx.hasCli('code') || ctx.exists(vscodeUserDir(ctx))) detected.push('vscode');
  if (ctx.exists(join(home, '.gemini')) || ctx.hasCli('gemini')) detected.push('gemini');
  // Cline's globalStorage dir exists only once the extension has run — writing
  // a config for an uninstalled extension would be a stray file, so gate on it.
  if (ctx.exists(join(vscodeUserDir(ctx), 'globalStorage', 'saoudrizwan.claude-dev'))) {
    detected.push('cline');
  }
  // Zed keeps SETTINGS at ~/.config/zed/settings.json on macOS too (XDG by
  // design), but that file only exists once the user has opened settings —
  // its data dir (macOS: ~/Library/Application Support/Zed) and CLI are the
  // reliable installed signals.
  if (
    ctx.exists(zedSettingsPath(ctx)) ||
    (ctx.platform === 'darwin' &&
      ctx.exists(join(ctx.homeDir, 'Library', 'Application Support', 'Zed'))) ||
    ctx.hasCli('zed')
  ) {
    detected.push('zed');
  }

  return detected;
}

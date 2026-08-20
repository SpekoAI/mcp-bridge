import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { HELP_TEXT, isCliEntrypoint, run } from '../src/index.js';

describe('spekoai-mcp CLI', () => {
  it('documents init as the only command', () => {
    expect(HELP_TEXT).toContain('spekoai-mcp init');
    expect(HELP_TEXT).toContain('SPEKO_API_KEY');
    expect(HELP_TEXT).toContain('OAuth');
    expect(HELP_TEXT).not.toContain('bridge');
  });

  it('prints top-level help', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(run([], {})).resolves.toBeUndefined();
      expect(write).toHaveBeenCalledWith(HELP_TEXT);
    } finally {
      write.mockRestore();
    }
  });

  it('rejects the removed bridge command', async () => {
    await expect(run(['bridge'], {})).rejects.toThrow(/Unknown command/);
  });

  it('routes init directly', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(
        run(
          ['init', '--dry-run', '--auth', 'oauth', '--tools', 'cursor', '--scope', 'project'],
          {},
        ),
      ).resolves.toBeUndefined();
    } finally {
      write.mockRestore();
    }
  });

  it('treats npm .bin symlinks as direct CLI execution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spekoai-mcp-'));
    try {
      const target = join(dir, 'dist-index.js');
      const symlink = join(dir, 'spekoai-mcp');
      writeFileSync(target, '');
      symlinkSync(target, symlink);
      expect(isCliEntrypoint(symlink, pathToFileURL(target).href)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

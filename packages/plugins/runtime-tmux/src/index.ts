import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
  AttachInfo,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "tmux",
  slot: "runtime" as const,
  description: "Runtime plugin: tmux sessions",
  version: "0.1.0",
};

/** Only allow safe characters in session IDs */
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Run a tmux command and return stdout */
async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args);
  return stdout.trimEnd();
}

function looksLikeCodexPane(output: string): boolean {
  const tail = output.split("\n").slice(-40).join("\n");
  return /OpenAI Codex/i.test(tail) || (/\bgpt-[\w.-]+\b/.test(tail) && /(?:^|\n)\s*›/.test(tail));
}

function hasUnsubmittedPasteMarker(output: string): boolean {
  return /\[Pasted Content \d+ chars\]/i.test(output);
}

async function sendCodexLiteralMessage(sessionId: string, message: string): Promise<void> {
  const chunkSize = 120;
  const lines = message.split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";

    for (let offset = 0; offset < line.length; offset += chunkSize) {
      await tmux("send-keys", "-t", sessionId, "-l", line.slice(offset, offset + chunkSize));
      await sleep(25);
    }

    if (lineIndex < lines.length - 1) {
      await tmux("send-keys", "-t", sessionId, "C-j");
      await sleep(40);
    }
  }
}

export function create(): Runtime {
  return {
    name: "tmux",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);
      const sessionName = config.sessionId;

      // Build environment flags: -e KEY=VALUE for each env var
      const envArgs: string[] = [];
      for (const [key, value] of Object.entries(config.environment ?? {})) {
        envArgs.push("-e", `${key}=${value}`);
      }

      // Create tmux session in detached mode
      await tmux("new-session", "-d", "-s", sessionName, "-c", config.workspacePath, ...envArgs);
      // Give the interactive shell time to finish startup hooks before we type
      // into it. Without this, early send-keys can get mangled on fresh panes.
      await sleep(1000);

      // Send the launch command — clean up the session if this fails.
      // For long commands, write a temp script and launch that with a short
      // shell command instead of pasting thousands of chars into the shell.
      let sendCommand = config.launchCommand;
      let launchScriptPath: string | null = null;
      if (config.launchCommand.length > 200) {
        launchScriptPath = join(tmpdir(), `ao-launch-${randomUUID()}.sh`);
        const launchScript = `#!/usr/bin/env bash
rm -- "$0"
${config.launchCommand}
`;
        writeFileSync(launchScriptPath, launchScript, { encoding: "utf-8", mode: 0o700 });
        sendCommand = `bash ${shellEscape(launchScriptPath)}`;
      }

      try {
        await tmux("send-keys", "-t", sessionName, "-l", sendCommand);
        await sleep(launchScriptPath ? 150 : 0);
        await tmux("send-keys", "-t", sessionName, "Enter");
      } catch (err: unknown) {
        if (launchScriptPath) {
          try {
            unlinkSync(launchScriptPath);
          } catch {
            /* ignore cleanup errors */
          }
        }
        try {
          await tmux("kill-session", "-t", sessionName);
        } catch {
          // Best-effort cleanup
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to send launch command to session "${sessionName}": ${msg}`, {
          cause: err,
        });
      }

      return {
        id: sessionName,
        runtimeName: "tmux",
        data: {
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        await tmux("kill-session", "-t", handle.id);
      } catch {
        // Session may already be dead — that's fine
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const usesPasteBuffer = message.includes("\n") || message.length > 200;
      let isCodex = false;

      try {
        const tail = await tmux("capture-pane", "-t", handle.id, "-p", "-S", "-60");
        isCodex = looksLikeCodexPane(tail);
      } catch {
        // Best-effort detection only.
      }

      if (isCodex) {
        await sendCodexLiteralMessage(handle.id, message);
        await sleep(200);
        await tmux("send-keys", "-t", handle.id, "Enter");
        return;
      }

      // Clear any partial input/copy-mode first. Some TUIs can swallow Enter
      // when the pane is not in normal compose mode.
      await tmux("send-keys", "-t", handle.id, "Escape");
      await sleep(100);

      // For long or multiline messages, use load-buffer + paste-buffer
      // Use randomUUID to avoid temp file collisions on concurrent sends
      if (usesPasteBuffer) {
        const bufferName = `ao-${randomUUID()}`;
        const tmpPath = join(tmpdir(), `ao-send-${randomUUID()}.txt`);
        writeFileSync(tmpPath, message, { encoding: "utf-8", mode: 0o600 });
        try {
          await tmux("load-buffer", "-b", bufferName, tmpPath);
          await tmux("paste-buffer", "-b", bufferName, "-t", handle.id, "-d");
        } finally {
          // Clean up temp file and tmux buffer (in case paste-buffer failed
          // and the -d flag didn't delete it)
          try {
            unlinkSync(tmpPath);
          } catch {
            // ignore cleanup errors
          }
          try {
            await tmux("delete-buffer", "-b", bufferName);
          } catch {
            // Buffer may already be deleted by -d flag — that's fine
          }
        }
      } else {
        // Use -l (literal) so text like "Enter" or "Space" isn't interpreted
        // as tmux key names
        await tmux("send-keys", "-t", handle.id, "-l", message);
      }

      // Let tmux (and the TUI app) finish processing pasted text before Enter.
      // Paste-buffer can lag behind key events on busy panes; use a longer delay
      // for multiline/long messages to avoid leaving text in the composer unsent.
      await sleep(usesPasteBuffer ? 1200 : 300);
      await tmux("send-keys", "-t", handle.id, "Enter");

      // Codex can occasionally keep large pasted content in the composer without
      // submitting on the first Enter. Detect the marker and retry with C-m.
      if (usesPasteBuffer) {
        await sleep(350);
        try {
          const tail = await tmux("capture-pane", "-t", handle.id, "-p", "-S", "-40");
          if (hasUnsubmittedPasteMarker(tail)) {
            await tmux("send-keys", "-t", handle.id, "C-m");
          }
        } catch {
          // Best-effort fallback only — ignore capture errors
        }
      }
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        return await tmux("capture-pane", "-t", handle.id, "-p", "-S", `-${lines}`);
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        await tmux("has-session", "-t", handle.id);
        return true;
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data.createdAt as number) ?? Date.now();
      return {
        uptimeMs: Date.now() - createdAt,
      };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      return {
        type: "tmux",
        target: handle.id,
        command: `tmux attach -t ${handle.id}`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;

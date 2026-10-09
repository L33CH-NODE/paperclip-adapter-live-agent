/**
 * How each harness runs one job headless with its OWN login. The prompt is
 * always handed over as a file (or stdin), never as a command-line argument,
 * so long Paperclip briefs don't hit Windows' 32K command-line limit.
 *
 * Auto-approval: a headless run can't answer tool-approval prompts, so each
 * CLI runs in its "approve everything" mode by default, which matches
 * Paperclip's own claude_local default (dangerouslySkipPermissions). Pass
 * --no-auto-approve to drop those flags if your harness is configured with an
 * allowlist instead.
 */

export interface DriverOptions {
  promptFile: string;
  cwd: string;
  model: string | null;
  autoApprove: boolean;
}

export interface CliDriver {
  kind: "cli";
  command: string;
  args(opts: DriverOptions): string[];
  /** Feed the prompt on stdin instead of (or as well as) the file. */
  promptOnStdin?: boolean;
}

export interface HttpDriver {
  kind: "ollama";
}

export type Driver = CliDriver | HttpDriver;

export const DRIVERS: Record<string, Driver> = {
  claude: {
    kind: "cli",
    command: "claude",
    promptOnStdin: true,
    args: ({ model, autoApprove }) => [
      "--print",
      "--output-format",
      "text",
      ...(autoApprove ? ["--permission-mode", "bypassPermissions"] : []),
      ...(model ? ["--model", model] : []),
    ],
  },
  grok: {
    kind: "cli",
    command: "grok",
    args: ({ promptFile, cwd, model, autoApprove }) => [
      "--prompt-file",
      promptFile,
      "--cwd",
      cwd,
      ...(autoApprove ? ["--always-approve"] : []),
      ...(model ? ["-m", model] : []),
    ],
  },
  opencode: {
    kind: "cli",
    command: "opencode",
    args: ({ promptFile, cwd, model, autoApprove }) => [
      "run",
      "--dir",
      cwd,
      "-f",
      promptFile,
      ...(autoApprove ? ["--auto"] : []),
      ...(model ? ["-m", model] : []),
      "Follow the instructions in the attached file exactly. They are your full task brief.",
    ],
  },
  hermes: {
    kind: "cli",
    command: "hermes",
    args: ({ promptFile, autoApprove }) => [
      "chat",
      "--query-file",
      promptFile,
      "--oneshot",
      "-Q",
      ...(autoApprove ? ["--yolo"] : []),
    ],
  },
  ollama: { kind: "ollama" },
};

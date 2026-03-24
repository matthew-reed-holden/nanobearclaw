import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { readFileSync, existsSync } from 'fs';

export interface SpawnOptions {
  sessionKey: string;
  model: string;
  systemPrompt: string;
  initialPrompt?: string; // If set, passed as positional arg to `claude -p <message>`
  onOutput?: (data: string) => void;
  onError?: (data: string) => void;
  onExit?: (code: number | null) => void;
}

export interface AgentSession {
  sessionKey: string;
  pid: number;
  process: ChildProcess;
  startedAt: Date;
}

/**
 * Load key=value pairs from a .env file and return as a Record.
 * Skips blank lines and comments (#). Strips optional quotes from values.
 */
function loadDotEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(path)) return env;
  try {
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes (single or double)
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  } catch {
    // If the file can't be read, return empty — don't crash the spawn
  }
  return env;
}

const DOTENV_PATH = '/home/node/.nanoclaw/.env';

export class ChildProcessRunner extends EventEmitter {
  private sessions = new Map<string, AgentSession>();
  private maxConcurrent: number;

  constructor(config: { maxConcurrent: number }) {
    super();
    this.maxConcurrent = config.maxConcurrent;
  }

  async spawn(opts: SpawnOptions): Promise<AgentSession> {
    if (this.sessions.size >= this.maxConcurrent) {
      throw new Error(`Max concurrent agents reached (${this.maxConcurrent})`);
    }
    if (this.sessions.has(opts.sessionKey)) {
      throw new Error(`Session ${opts.sessionKey} already exists`);
    }

    const args = [
      '-p', // Print/pipe mode — required for non-interactive use
      '--verbose', // Required: stream-json needs --verbose in print mode
      '--model',
      opts.model,
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions', // Required — no TTY to accept permissions
      ...(opts.systemPrompt ? ['--system-prompt', opts.systemPrompt] : []),
      ...(opts.initialPrompt ? [opts.initialPrompt] : []), // Positional arg: the user message
    ];

    // Merge process.env with .env file written by ApplyConfig (contains
    // ANTHROPIC_API_KEY for dev or ANTHROPIC_BASE_URL for Bifrost/prod).
    // .env values take precedence so the config bridge can override defaults.
    const dotEnv = loadDotEnv(DOTENV_PATH);
    const childEnv = { ...process.env, ...dotEnv };

    // Pre-flight: Claude CLI requires ANTHROPIC_API_KEY (or OAuth state in
    // ~/.claude/) to authenticate. Without it, the CLI exits with "Not logged
    // in · Please run /login". Fail fast with a clear message instead.
    if (!childEnv.ANTHROPIC_API_KEY && !childEnv.ANTHROPIC_BASE_URL) {
      throw new Error(
        'No Anthropic credentials configured. Call ApplyConfig with your ' +
        'ANTHROPIC_API_KEY before sending messages.'
      );
    }

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });

    // When initialPrompt is set, the message is passed as a positional arg
    // and stdin isn't needed. Close it to prevent the "no stdin data" warning.
    // When no initialPrompt, keep stdin open for sendMessage() (multi-turn).
    if (opts.initialPrompt) {
      proc.stdin?.end();
    }

    const session: AgentSession = {
      sessionKey: opts.sessionKey,
      pid: proc.pid!,
      process: proc,
      startedAt: new Date(),
    };

    proc.stdout?.on('data', (data: Buffer) => {
      const str = data.toString();
      opts.onOutput?.(str);
      this.emit('output', opts.sessionKey, str);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const str = data.toString();
      opts.onError?.(str);
      this.emit('stderr', opts.sessionKey, str);
    });

    proc.on('exit', (code) => {
      this.sessions.delete(opts.sessionKey);
      opts.onExit?.(code);
      this.emit('exit', opts.sessionKey, code);
    });

    this.sessions.set(opts.sessionKey, session);
    return session;
  }

  async sendMessage(sessionKey: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) throw new Error(`Session ${sessionKey} not found`);
    session.process.stdin?.write(message + '\n');
  }

  async kill(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    session.process.kill('SIGTERM');
    this.sessions.delete(sessionKey);
  }

  async killAll(): Promise<void> {
    for (const [key] of this.sessions) {
      await this.kill(key);
    }
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  getSession(sessionKey: string): AgentSession | undefined {
    return this.sessions.get(sessionKey);
  }
}

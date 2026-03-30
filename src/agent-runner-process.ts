import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  AgentRunner,
  SpawnOptions as ISpawnOptions,
  AgentSession as IAgentSession,
} from './management/agent-runner.js';

export interface SpawnOptions extends ISpawnOptions {
  cwd?: string;
  groupFolder?: string;
  isMain?: boolean;
  assistantName?: string;
  onOutput?: (data: string) => void;
  onError?: (data: string) => void;
  onExit?: (code: number | null) => void;
}

export interface AgentSession extends IAgentSession {
  pid: number;
  process: ChildProcess;
}

interface ContainerInput {
  prompt: string;
  systemPrompt?: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  assistantName?: string;
  workspaceDir?: string;
}

const DOTENV_PATH = '/home/node/.nanoclaw/.env';

/**
 * Load key=value pairs from a .env file and return as a Record.
 * Skips blank lines and comments (#). Strips optional quotes from values.
 */
function loadDotEnv(envPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(envPath)) return env;
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_RUNNER_PATH = path.resolve(
  __dirname,
  '../agent-runner/dist/index.js',
);

/**
 * AgentRunner implementation that spawns the agent-runner as a child process
 * with stdin-based IPC, as an alternative to ChildProcessRunner which spawns
 * the `claude` CLI directly.
 */
export class AgentRunnerProcess extends EventEmitter implements AgentRunner {
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

    // Merge process.env with .env file written by ApplyConfig (contains
    // ANTHROPIC_API_KEY for dev or ANTHROPIC_BASE_URL for Bifrost/prod).
    // .env values take precedence so the config bridge can override defaults.
    const dotEnv = loadDotEnv(DOTENV_PATH);
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      ...dotEnv,
      IPC_MODE: 'stdin',
    };

    // Pre-flight: agent-runner requires credentials to authenticate.
    // Fail fast with a clear message instead of a cryptic error.
    const hasCredentials =
      childEnv.ANTHROPIC_API_KEY ||
      childEnv.ANTHROPIC_BASE_URL ||
      childEnv.CLAUDE_CODE_OAUTH_TOKEN ||
      childEnv.ANTHROPIC_AUTH_TOKEN;

    if (!hasCredentials) {
      throw new Error(
        'No Anthropic credentials configured. Call ApplyConfig with your ' +
          'ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN before sending messages.',
      );
    }

    // If a setup-token (sk-ant-oat*) was placed in ANTHROPIC_API_KEY by
    // mistake, move it to CLAUDE_CODE_OAUTH_TOKEN where the SDK expects it.
    if (
      childEnv.ANTHROPIC_API_KEY &&
      childEnv.ANTHROPIC_API_KEY.startsWith('sk-ant-oat') &&
      !childEnv.CLAUDE_CODE_OAUTH_TOKEN
    ) {
      childEnv.CLAUDE_CODE_OAUTH_TOKEN = childEnv.ANTHROPIC_API_KEY;
      delete childEnv.ANTHROPIC_API_KEY;
    }

    const proc = spawn('node', [AGENT_RUNNER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });

    // Build and write ContainerInput as the first stdin line.
    // The agent-runner reads this on startup to configure the session.
    const containerInput: ContainerInput = {
      prompt: opts.initialPrompt || '',
      systemPrompt: opts.systemPrompt || undefined,
      sessionId: opts.resumeSessionId,
      groupFolder: opts.groupFolder || opts.sessionKey,
      chatJid: opts.sessionKey,
      isMain: opts.isMain || false,
      assistantName: opts.assistantName,
      workspaceDir: opts.cwd,
    };
    proc.stdin?.write(JSON.stringify(containerInput) + '\n');

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
    session.process.stdin?.write(
      JSON.stringify({ type: 'message', text: message }) + '\n',
    );
  }

  async kill(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    // Send graceful close signal via stdin
    session.process.stdin?.write(JSON.stringify({ type: 'close' }) + '\n');
    // SIGTERM fallback after 5 seconds if the process hasn't exited
    const proc = session.process;
    setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }, 5000);
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

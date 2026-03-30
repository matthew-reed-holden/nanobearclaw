// container/skills/x-integration/client.ts
import { Client } from '@xdevplatform/xdk';

let cachedClient: Client | null = null;
let cachedUserId: string | null = null;

export function getXClient(): Client {
  if (cachedClient) return cachedClient;

  const accessToken = process.env.X_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('X_ACCESS_TOKEN not set. OneCLI injects this at container startup.');
  }

  cachedClient = new Client({ accessToken });
  return cachedClient;
}

export async function getAuthenticatedUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;

  const client = getXClient();
  const me = await client.users.getMe();
  if (!me.data?.id) {
    throw new Error('Failed to get authenticated user ID from X API');
  }
  cachedUserId = me.data.id;
  return cachedUserId;
}

export function isDryRun(): boolean {
  return process.env.X_DRY_RUN === 'true';
}

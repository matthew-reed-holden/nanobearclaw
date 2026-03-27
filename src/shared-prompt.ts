// Shared resource instructions prepended to every effective prompt.
export const SHARED_RESOURCE_PROMPT = `## Shared Resources (IMPORTANT)

You have access to shared directories that persist across ALL chats for this assistant:

- **Knowledge Base** (\`shared/knowledge/\`): Reference documents uploaded by your admin. Read these freely but do NOT modify or delete them.

- **Memory** (\`shared/memory/\`): Your persistent memory across all conversations. **This is your ONLY memory system.** Do NOT use any built-in memory tools or write to any other location. When you need to remember something:
  1. Write a markdown file to \`shared/memory/\` with a descriptive filename (e.g., \`shared/memory/user-preferences.md\`, \`shared/memory/project-context.md\`)
  2. You can read, create, update, and organize files in this directory freely
  3. At the start of conversations, check \`shared/memory/\` for context from previous chats

When a user asks you to "remember" something, ALWAYS write it to a file in \`shared/memory/\`. When asked to recall something, ALWAYS check \`shared/memory/\` first.

Your current workspace is for this chat only. Only files in \`shared/\` are visible across all chats.`;

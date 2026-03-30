// src/management/social-publish.ts
import { Client } from '@xdevplatform/xdk';

export interface SocialPublishParams {
  approvalId: string;
  actionType: string; // x_post, x_reply, x_quote
  content: string;
  platform: string;
  accountId: string;
  targetPostId?: string;
}

export interface SocialPublishResult {
  success: boolean;
  postId?: string;
  postUrl?: string;
  error?: string;
}

export async function handleSocialPublish(
  params: SocialPublishParams,
): Promise<SocialPublishResult> {
  const accessToken = process.env.X_ACCESS_TOKEN;
  if (!accessToken) {
    return {
      success: false,
      error:
        'X_ACCESS_TOKEN not set. OneCLI injects this at container startup.',
    };
  }

  const client = new Client({ accessToken });

  try {
    switch (params.actionType) {
      case 'x_post': {
        const response = await client.posts.create({ text: params.content });
        const id = response.data?.id;
        return {
          success: true,
          postId: id,
          postUrl: id ? `https://x.com/i/web/status/${id}` : undefined,
        };
      }
      case 'x_reply': {
        if (!params.targetPostId) {
          return { success: false, error: 'targetPostId required for x_reply' };
        }
        const response = await client.posts.create({
          text: params.content,
          reply: { in_reply_to_tweet_id: params.targetPostId },
        });
        const id = response.data?.id;
        return {
          success: true,
          postId: id,
          postUrl: id ? `https://x.com/i/web/status/${id}` : undefined,
        };
      }
      case 'x_quote': {
        if (!params.targetPostId) {
          return { success: false, error: 'targetPostId required for x_quote' };
        }
        const response = await client.posts.create({
          text: params.content,
          quoteTweetId: params.targetPostId,
        });
        const id = response.data?.id;
        return {
          success: true,
          postId: id,
          postUrl: id ? `https://x.com/i/web/status/${id}` : undefined,
        };
      }
      default:
        return {
          success: false,
          error: `Unknown action type: ${params.actionType}`,
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

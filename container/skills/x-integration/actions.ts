// container/skills/x-integration/actions.ts
import { getXClient, getAuthenticatedUserId, isDryRun } from './client.js';
import type { ActionResult } from '../social-monitor/interfaces.js';

export async function postTweet(text: string): Promise<ActionResult> {
  if (isDryRun()) {
    return { success: true, dryRun: true, url: `(dry-run) would post: "${text.slice(0, 50)}..."` };
  }
  const client = getXClient();
  const response = await client.posts.create({ text });
  const id = response.data?.id;
  return {
    success: true,
    platformId: id,
    url: id ? `https://x.com/i/web/status/${id}` : undefined,
  };
}

export async function replyToTweet(tweetId: string, text: string): Promise<ActionResult> {
  if (isDryRun()) {
    return { success: true, dryRun: true, url: `(dry-run) would reply to ${tweetId}` };
  }
  const client = getXClient();
  const response = await client.posts.create({
    text,
    reply: { in_reply_to_tweet_id: tweetId },
  });
  const id = response.data?.id;
  return {
    success: true,
    platformId: id,
    url: id ? `https://x.com/i/web/status/${id}` : undefined,
  };
}

export async function quoteTweet(tweetId: string, comment: string): Promise<ActionResult> {
  if (isDryRun()) {
    return { success: true, dryRun: true, url: `(dry-run) would quote ${tweetId}` };
  }
  const client = getXClient();
  const response = await client.posts.create({
    text: comment,
    quoteTweetId: tweetId,
  });
  const id = response.data?.id;
  return {
    success: true,
    platformId: id,
    url: id ? `https://x.com/i/web/status/${id}` : undefined,
  };
}

export async function likeTweet(tweetId: string): Promise<ActionResult> {
  if (isDryRun()) {
    return { success: true, dryRun: true };
  }
  const client = getXClient();
  const userId = await getAuthenticatedUserId();
  await client.users.likePost(userId, { body: { tweetId } });
  return { success: true };
}

export async function retweet(tweetId: string): Promise<ActionResult> {
  if (isDryRun()) {
    return { success: true, dryRun: true };
  }
  const client = getXClient();
  const userId = await getAuthenticatedUserId();
  await client.users.repostPost(userId, { body: { tweetId } });
  return { success: true };
}

export async function searchRecent(query: string, maxResults = 10): Promise<unknown> {
  const client = getXClient();
  const response = await client.posts.searchRecent(query, {
    maxResults,
    tweetFields: ['author_id', 'created_at', 'public_metrics'],
  });
  return response;
}

export async function getHomeTimeline(maxResults = 50): Promise<unknown> {
  const client = getXClient();
  const userId = await getAuthenticatedUserId();
  const response = await client.users.getTimeline(userId, {
    maxResults,
    tweetFields: ['author_id', 'created_at', 'public_metrics'],
    expansions: ['author_id'],
    userFields: ['name', 'username', 'public_metrics'],
  });
  return response;
}

export async function getUserTweets(maxResults = 100): Promise<unknown> {
  const client = getXClient();
  const userId = await getAuthenticatedUserId();
  const response = await client.users.getPosts(userId, {
    maxResults,
    tweetFields: ['created_at', 'public_metrics', 'referenced_tweets'],
  });
  return response;
}

export async function getLikedTweets(maxResults = 100): Promise<unknown> {
  const client = getXClient();
  const userId = await getAuthenticatedUserId();
  const response = await client.users.getLikedPosts(userId, {
    maxResults,
    tweetFields: ['author_id', 'created_at', 'public_metrics'],
  });
  return response;
}

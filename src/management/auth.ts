import { timingSafeEqual } from 'crypto';

export function validateToken(token: string): boolean {
  const expected = process.env.MANAGEMENT_TOKEN || '';
  if (!expected || !token) return false;
  if (expected.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

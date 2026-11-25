import type pg from 'pg';
import { ServiceError } from '../services/meetup';

export async function lockVerifiedAccount(client: pg.PoolClient, userId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId))
    throw new ServiceError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
  // Account deletion locks auth_user before its domain cleanup. All writers
  // must take the same order and retain verification through their commit.
  const row = (await client.query(
    'SELECT name,"emailVerified" AS verified FROM auth_user WHERE id=$1 FOR SHARE',
    [userId],
  )).rows[0];
  if (!row) throw new ServiceError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
  if (!row.verified) throw new ServiceError(403, 'EMAIL_NOT_VERIFIED', '이메일 인증이 필요합니다.');
  return row.name as string;
}

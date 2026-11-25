import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { getMigrations } from 'better-auth/db/migration';
import type pg from 'pg';
import { createPool } from '../src/server/db';
import { createAuth } from '../src/server/auth/service';
import { migrateWalking } from '../src/server/migrations';
import { databaseMeetings } from '../src/server/services/meetings';
import { databaseAttendance } from '../src/server/services/attendance';
import { databaseCommunity } from '../src/server/services/community';
import { communityCommandSchema, profileSchema } from '../src/contracts/community';
import place from '../contracts/fixtures/place.json' with { type: 'json' };

describe.runIf(process.env.TEST_DATABASE_URL)('account deletion and domain writes', () => {
  const schema = 'account_lock_' + randomUUID().replaceAll('-', '');
  let admin: pg.Pool, pool: pg.Pool;
  beforeAll(async () => {
    admin = createPool(process.env.TEST_DATABASE_URL!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.href);
    const auth = createAuth({
      pool, origin: 'http://127.0.0.1:3191', secret: randomBytes(32).toString('hex'),
      sendMail: async () => {},
    });
    await (await getMigrations(auth.options)).runMigrations();
    await migrateWalking(pool);
    await pool.query('INSERT INTO places(source,source_key,document) VALUES($1,$2,$3)', [
      'data.go.kr/15012890', place.place.id.replace('park-', ''), place.place,
    ]);
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function identity(name = '경합 시험') {
    const id = randomUUID();
    await pool.query(
      'INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',
      [id, name, `${id}@example.test`],
    );
    return id;
  }

  test.each(['cancel', 'leave', 'attendance', 'comment'] as const)(
    '%s commits before a concurrent deletion of its caller without a deadlock',
    async (action) => {
      const host = await identity(), guest = await identity();
      const user = action === 'cancel' ? host : guest;
      const meetings = databaseMeetings(pool);
      const starts = Date.now() + 60_000;
      const { id } = await meetings.command(host, randomUUID(), {
        title: '삭제와 쓰기 경합', description: '', sport: 'walking', placeId: place.place.id,
        startsAt: new Date(starts).toISOString(), endsAt: new Date(starts + 3_600_000).toISOString(),
        capacity: 5,
      });
      await meetings.command(guest, randomUUID(), { action: 'join', expectedVersion: 1 }, id);

      let release = () => {};
      let locked: (pid: number) => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const domainLocked = new Promise<number>((resolve) => { locked = resolve; });
      // Keep real transactions/SQL, pausing only after the domain row is locked.
      const gatedPool = new Proxy(pool, {
        get(target, property) {
          if (property === 'connect') return async () => {
            const client = await target.connect();
            let pid: number;
            try {
              await client.query("SET statement_timeout='5s'");
              pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
            } catch (error) {
              client.release();
              throw error;
            }
            return new Proxy(client, {
              get(connection, key) {
                if (key === 'query') return async (sql: string, values?: unknown[]) => {
                  const result = await connection.query(sql, values);
                  if (sql.includes('FROM meetups') && sql.endsWith('FOR UPDATE')) {
                    locked(pid);
                    await gate;
                  }
                  return result;
                };
                const value = Reflect.get(connection, key);
                return typeof value === 'function' ? value.bind(connection) : value;
              },
            });
          };
          return Reflect.get(target, property);
        },
      });
      const perform = () => action === 'attendance'
        ? databaseAttendance(gatedPool).command(user, randomUUID(), id, {
            action: 'requestReview', reason: '위치 확인 실패',
          })
        : action === 'comment'
          ? databaseCommunity(gatedPool).command(user, randomUUID(), {
              action: 'comment', parent: 'meetup', id, body: '참여 안내 확인',
            })
          : databaseMeetings(gatedPool).command(user, randomUUID(), {
              action, expectedVersion: 2,
            }, id);
      const command = perform().then(
        (result) => ({ ok: true, result }),
        (error: unknown) => ({ ok: false, error }),
      );
      let deletion: Promise<unknown> | undefined;
      let deleter: pg.PoolClient | undefined;
      try {
        deleter = await pool.connect();
        const commandPID = await Promise.race([
          domainLocked,
          command.then(() => { throw new Error('Command finished before acquiring its domain lock'); }),
        ]);
        await deleter.query("SET statement_timeout='5s'");
        const deletePID = (await deleter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
        deletion = deleter.query('DELETE FROM auth_user WHERE id=$1', [user]).then(
          (result) => ({ ok: true, rows: result.rowCount }),
          (error: unknown) => ({ ok: false, error }),
        );
        await expect.poll(async () => (await pool.query(
          'SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked', [commandPID, deletePID],
        )).rows[0].blocked, { timeout: 2_000 }).toBe(true);
        release();
        expect(await command).toMatchObject({ ok: true });
        expect(await deletion).toEqual({ ok: true, rows: 1 });
        expect((await pool.query('SELECT id FROM auth_user WHERE id=$1', [user])).rowCount).toBe(0);
        const after = await meetings.detail(id);
        expect(after.meetup.status).toBe(action === 'cancel' ? 'cancelled' : 'open');
        expect(after.meetup.participantCount).toBe(1);
      } finally {
        release();
        await Promise.allSettled([command, deletion]);
        deleter?.release();
      }
    }, 15_000,
  );

  test.each(['', 'x'.repeat(61)])('legacy profile name %j remains readable and editable', async (name) => {
    const user = await identity(name), community = databaseCommunity(pool);
    const before = profileSchema.parse(await community.profile(user));
    expect(before.name).toBe(name);
    expect(communityCommandSchema.safeParse({
      action: 'profile', name, regionCode: null, expectedVersion: before.version,
    }).success).toBe(false);
    await community.command(user, randomUUID(), communityCommandSchema.parse({
      action: 'profile', name: '수정한 이름', regionCode: null, expectedVersion: before.version,
    }));
    expect(profileSchema.parse(await community.profile(user)).name).toBe('수정한 이름');
  });
});

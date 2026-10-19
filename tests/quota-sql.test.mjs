import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Real PostgreSQL engine, in memory. It verifies migration syntax/logic/privileges.
// PGlite serializes queries: true multi-connection lock tests still require hosted Postgres.
test('quota migration executes with PostgreSQL and enforces caps, cooldown, day boundary and grants', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      insert into auth.users select ('00000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid from generate_series(1,110) n;`);
    await db.exec(await readFile(new URL('../supabase/migrations/202610170001_free_quota.sql', import.meta.url), 'utf8'));
    const user = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
    const call = async (n, consume) => (await db.query('select public.free_quota($1::uuid, $2::boolean) as q', [user(n), consume])).rows[0].q;
    assert.equal((await call(1, false)).used, 0);
    assert.equal((await db.query('select count(*)::int as n from public.free_daily_users')).rows[0].n, 0);
    const first = await call(1, true);
    assert.equal(first.used, 1); assert.equal(first.allowed, true);
    const cool = await call(1, true);
    assert.equal(cool.allowed, false); assert.equal(cool.reason, 'cooldown'); assert.equal(cool.used, 1);
    for (let i = 2; i <= 5; i++) {
      await db.exec("update public.free_daily_users set last_request_at = clock_timestamp() - interval '11 seconds'");
      assert.equal((await call(1, true)).used, i);
    }
    const sixth = await call(1, true);
    assert.equal(sixth.allowed, false); assert.equal(sixth.reason, 'user_limit');
    assert.equal((await db.query('select used from public.free_daily_global')).rows[0].used, 5);
    for (let n = 2; n <= 96; n++) assert.equal((await call(n, true)).allowed, true);
    const global = await call(97, true);
    assert.equal(global.reason, 'global_limit'); assert.equal(global.allowed, false);
    assert.equal((await db.query('select used from public.free_daily_global')).rows[0].used, 100);
    // An old day never contributes to today's quota. Shift rows, not the clock.
    await db.exec("update public.free_daily_global set day = day - 1; update public.free_daily_users set day = day - 1;");
    const nextDay = await call(1, true);
    assert.equal(nextDay.used, 1); assert.equal(nextDay.allowed, true);
    const tomorrow = (await db.query("select (((clock_timestamp() at time zone 'Asia/Shanghai')::date+1)::timestamp at time zone 'Asia/Shanghai') as t")).rows[0].t;
    assert.equal(Date.parse(nextDay.reset_at), Date.parse(tomorrow));
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(call(1, false), /permission denied/);
      await assert.rejects(db.query('select * from public.free_daily_users'), /permission denied/);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    assert.equal((await call(1, false)).used, 1);
    await db.exec('reset role');
  } finally { await db.close(); }
});

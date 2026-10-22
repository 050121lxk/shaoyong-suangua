import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const user = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ip = n => String(n).padStart(64, 'a').slice(-64).replace(/[^0-9a-f]/g, 'b');

test('guest pool: 3 per guest per day, 100 across guests, 4 guests per network per day, separate from users, stale cleanup', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key, is_anonymous boolean not null default false,
        created_at timestamptz not null default now(), last_sign_in_at timestamptz);
      insert into auth.users(id, is_anonymous) select ('00000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid, n > 1 from generate_series(1,60) n;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
      grant usage on schema auth to anon, authenticated; grant execute on all functions in schema auth to anon, authenticated;
      grant usage on schema public to anon, authenticated;`);
    for (const file of ['202610170001_free_quota.sql', '202610200001_global_quota_remaining.sql', '202610220001_chat_last_session.sql',
      '202610230001_guest_quota.sql', '202610230002_guest_cleanup_unused.sql']) {
      await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    }
    const guest = async (n, net, consume = true) => (await db.query('select public.guest_quota($1::uuid, $2, $3) as q', [user(n), ip(net), consume])).rows[0].q;
    const cool = () => db.exec("update public.free_daily_users set last_request_at = clock_timestamp() - interval '11 seconds'");

    const peek = await guest(2, 1, false);
    assert.deepEqual([peek.allowed, peek.used, peek.limit, peek.global_remaining], [true, 0, 3, 100]);
    assert.equal((await guest(2, 1)).used, 1);
    assert.equal((await guest(2, 1)).reason, 'cooldown');
    await cool(); assert.equal((await guest(2, 1)).used, 2);
    await cool(); assert.equal((await guest(2, 1)).used, 3);
    await cool(); assert.equal((await guest(2, 1)).reason, 'user_limit');

    // Four different guests per network per day; the fifth is refused, existing ones keep working.
    for (const n of [3, 4, 5]) assert.equal((await guest(n, 1)).allowed, true);
    const fifth = await guest(6, 1);
    assert.equal(fifth.reason, 'ip_limit'); assert.equal(fifth.used, 0);
    assert.equal((await guest(6, 1, false)).allowed, false, 'quota display reflects the network limit');
    await cool(); assert.equal((await guest(3, 1)).allowed, true, 'already-counted guest on the same network still allowed');
    assert.equal((await guest(6, 2)).allowed, true, 'same guest on another network is allowed');

    // Guest pool is independent of the signed-in pool.
    const before = (await db.query('select coalesce(sum(used),0)::int as n from public.free_daily_global')).rows[0].n;
    assert.equal(before, 0);
    const signed = (await db.query('select public.free_quota($1::uuid, true) as q', [user(1)])).rows[0].q;
    assert.equal(signed.global_remaining, 99);

    // Fill the guest pool to 100.
    await db.exec(`update public.free_daily_guest_global set used = 99`);
    await cool();
    const last = await guest(7, 3);
    assert.equal(last.allowed, true); assert.equal(last.global_remaining, 0);
    await cool();
    const full = await guest(8, 4);
    assert.equal(full.reason, 'global_limit'); assert.equal(full.global_remaining, 0);
    assert.equal((await db.query('select public.free_quota($1::uuid, false) as q', [user(1)])).rows[0].q.global_remaining, 99, 'users unaffected');

    // Next Beijing day: per-guest counts, the pool and the network limit all start over.
    await db.exec(`update public.free_daily_guest_global set day = day - 1; update public.free_daily_users set day = day - 1;
      update public.free_guest_ip_daily set day = day - 1;`);
    assert.equal((await guest(2, 1)).used, 1);
    for (const n of [9, 10, 11]) { await cool(); assert.equal((await guest(n, 1)).allowed, true); }

    // Only sending marks a guest as used; viewing the quota does not.
    await guest(40, 9, false);
    assert.equal((await db.query(`select count(*)::int as n from public.guest_activity where user_id = $1`, [user(40)])).rows[0].n, 0);

    // Cleanup: never-used guests go after 1 day, used guests after 7 idle days; real users never.
    await db.exec(`update auth.users set created_at = now() - interval '30 days', last_sign_in_at = now() - interval '30 days';
      update auth.users set created_at = now() - interval '2 hours' where id = '${user(41)}';
      update public.guest_activity set last_used_at = now() - interval '8 days' where user_id <> '${user(2)}';
      update public.guest_activity set last_used_at = now() - interval '3 days' where user_id = '${user(3)}';
      insert into public.free_guest_ip_daily(day, ip_hash, user_id) values (current_date - 5, '${ip(9)}', '${user(2)}');`);
    const deleted = (await db.query('select public.cleanup_stale_guests() as n')).rows[0].n;
    const left = (await db.query('select id from auth.users order by id')).rows.map(r => r.id);
    assert.ok(left.includes(user(1)), 'non-anonymous users are never cleaned up');
    assert.ok(left.includes(user(2)), 'recently used guest kept');
    assert.ok(left.includes(user(3)), 'guest used 3 days ago kept');
    assert.ok(!left.includes(user(4)), 'guest idle 8 days removed');
    assert.ok(!left.includes(user(40)), 'guest that never sent, created a day+ ago, removed');
    assert.ok(left.includes(user(41)), 'brand-new unused guest kept for its first day');
    assert.ok(deleted >= 50);
    assert.equal((await db.query(`select count(*)::int as n from public.free_guest_ip_daily where day < current_date - 1`)).rows[0].n, 0);

    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(guest(2, 1, false), /permission denied/);
      await assert.rejects(db.query('select public.cleanup_stale_guests()'), /permission denied/);
      await assert.rejects(db.query('select * from public.free_guest_ip_daily'), /permission denied/);
      await db.exec('reset role');
    }
    await assert.rejects(db.query(`select public.guest_quota($1::uuid, '1.2.3.4', false)`, [user(2)]), /ip hash required/);

    // Guests cannot save a "上一局"; real accounts still can.
    const saveAs = async (n, anonymous) => {
      await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${user(n)}', false),
        set_config('request.jwt.claims', '{"is_anonymous": ${anonymous}}', false);`);
      try {
        return await db.query(`insert into public.chat_last_session(user_id, mode, context, messages) values ($1, 'free', '{}',
          '[{"role":"user","content":"q"},{"role":"assistant","content":"a"}]')`, [user(n)]);
      } finally { await db.exec('reset role'); }
    };
    await assert.rejects(saveAs(2, true), /row-level security/);
    await saveAs(1, false);
  } finally { await db.close(); }
});

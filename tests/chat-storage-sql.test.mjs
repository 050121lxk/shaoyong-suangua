import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const user = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const messages = text => JSON.stringify([{ role: 'user', content: text }, { role: 'assistant', content: '答' }]);

test('last-session storage: own row only, text only, one row per user, global 300 MiB wipe', async () => {
  const db = new PGlite();
  try {
    // Minimal Supabase auth stand-ins: auth.uid() reads the request's JWT subject.
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
      grant usage on schema public to anon, authenticated;
      insert into auth.users values ('${user(1)}'), ('${user(2)}');`);
    await db.exec(await readFile(new URL('../supabase/migrations/202610220001_chat_last_session.sql', import.meta.url), 'utf8'));
    const as = async (n, sql, params) => {
      await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${n ? user(n) : ''}', false);`);
      try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
    };
    const save = (n, owner, text) => as(n, `insert into public.chat_last_session(user_id, mode, context, messages) values ($1, 'free', '{}', $2::jsonb)
      on conflict (user_id) do update set messages = excluded.messages, updated_at = now()`, [user(owner), messages(text)]);

    await save(1, 1, '第一局');
    await save(1, 1, '第二局');
    let rows = (await as(1, 'select messages from public.chat_last_session')).rows;
    assert.equal(rows.length, 1, 'a new reading overwrites the old one');
    assert.equal(rows[0].messages[0].content, '第二局');

    await assert.rejects(save(2, 1, '冒充'), /row-level security/);
    await save(2, 2, '用户二');
    assert.equal((await as(1, 'select * from public.chat_last_session')).rows.length, 1, 'cannot read others');
    assert.equal((await as(1, `delete from public.chat_last_session where user_id = $1`, [user(2)])).affectedRows, 0);
    assert.equal((await as(0, 'select * from public.chat_last_session')).rows.length, 0, 'no session, no rows');
    await db.exec('set role anon');
    await assert.rejects(db.query('select * from public.chat_last_session'), /permission denied/);
    await db.exec('reset role');

    const image = JSON.stringify([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA' } }] }, { role: 'assistant', content: 'x' }]);
    await assert.rejects(as(1, `update public.chat_last_session set messages = $1::jsonb`, [image]), /text_only/);
    await assert.rejects(as(1, `update public.chat_last_session set messages = $1::jsonb`, [JSON.stringify([{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }])]), /text_only/);
    await assert.rejects(as(1, `update public.chat_last_session set messages = $1::jsonb`, [messages('字'.repeat(1500000))]), /chat_last_session_size/);
    await assert.rejects(as(1, 'select public.chat_last_session_cap()'), /permission denied/);

    // Lower the cap to exercise the wipe without writing 300 MiB.
    await db.exec(`create or replace function public.chat_storage_cap_bytes() returns bigint language sql stable set search_path = '' as $$ select 2000::bigint $$`);
    await save(2, 2, '长'.repeat(600));
    assert.equal((await db.query('select count(*)::int as n from public.chat_last_session')).rows[0].n, 2, 'still under the cap');
    await save(2, 2, '长'.repeat(700));
    assert.equal((await db.query('select count(*)::int as n from public.chat_last_session')).rows[0].n, 0, 'over the cap: everything is cleared');
    await save(1, 1, '清理后');
    assert.equal((await db.query('select count(*)::int as n from public.chat_last_session')).rows[0].n, 1);
    assert.equal((await as(1, 'delete from public.chat_last_session')).affectedRows, 1, '新一局 deletes own row');
  } finally { await db.close(); }
});

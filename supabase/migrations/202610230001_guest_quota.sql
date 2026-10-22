-- Guest (anonymous) access with its own pool, separate from signed-in users:
--   * each guest: 3 sends per Beijing day (resets at midnight), 10s cooldown;
--   * all guests together: 100 per day (signed-in users keep their own 100);
--   * per network: at most 4 different guests per day may use the pool
--     (keyed by an HMAC of the client IP computed in the Edge Function; raw IPs are never stored);
--   * guests unused for 7 days are deleted.
create table if not exists public.free_daily_guest_global (
  day date primary key,
  used integer not null default 0 check (used between 0 and 100)
);
create table if not exists public.free_guest_ip_daily (
  day date not null,
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (day, ip_hash, user_id)
);
create table if not exists public.guest_activity (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_used_at timestamptz not null default now()
);
alter table public.free_daily_guest_global enable row level security;
alter table public.free_guest_ip_daily enable row level security;
alter table public.guest_activity enable row level security;
revoke all on public.free_daily_guest_global, public.free_guest_ip_daily, public.guest_activity from anon, authenticated;

create or replace function public.guest_quota(p_user uuid, p_ip_hash text, p_consume boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (clock_timestamp() at time zone 'Asia/Shanghai')::date;
  v_reset timestamptz := ((v_day + 1)::timestamp at time zone 'Asia/Shanghai');
  v_global integer;
  v_used integer;
  v_last timestamptz;
  v_known boolean;
  v_ip_users integer;
  v_reason text;
begin
  if p_user is null or p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then raise exception 'user and ip hash required'; end if;
  insert into public.guest_activity(user_id, last_used_at) values (p_user, clock_timestamp())
    on conflict (user_id) do update set last_used_at = excluded.last_used_at;

  if p_consume then
    -- The guest-pool row lock serializes every guest consumption, including the per-IP count.
    insert into public.free_daily_guest_global(day) values (v_day) on conflict do nothing;
    select used into v_global from public.free_daily_guest_global where day = v_day for update;
    insert into public.free_daily_users(day, user_id) values (v_day, p_user) on conflict do nothing;
    select used, last_request_at into v_used, v_last from public.free_daily_users
      where day = v_day and user_id = p_user for update;
  else
    select used into v_global from public.free_daily_guest_global where day = v_day;
    select used, last_request_at into v_used, v_last from public.free_daily_users where day = v_day and user_id = p_user;
  end if;
  v_global := coalesce(v_global, 0);
  v_used := coalesce(v_used, 0);
  v_known := exists (select 1 from public.free_guest_ip_daily where day = v_day and ip_hash = p_ip_hash and user_id = p_user);
  select count(*) into v_ip_users from public.free_guest_ip_daily where day = v_day and ip_hash = p_ip_hash;

  v_reason := case
    when v_used >= 3 then 'user_limit'
    when v_global >= 100 then 'global_limit'
    when not v_known and v_ip_users >= 4 then 'ip_limit'
    when p_consume and v_last is not null and clock_timestamp() - v_last < interval '10 seconds' then 'cooldown'
  end;
  if not p_consume or v_reason is not null then
    return jsonb_build_object('allowed', v_reason is null, 'used', v_used, 'limit', 3,
      'global_available', v_global < 100, 'global_remaining', greatest(0, 100 - v_global), 'reset_at', v_reset)
      || case when v_reason is null then '{}'::jsonb else jsonb_build_object('reason', v_reason) end;
  end if;

  insert into public.free_guest_ip_daily(day, ip_hash, user_id) values (v_day, p_ip_hash, p_user) on conflict do nothing;
  update public.free_daily_guest_global set used = used + 1 where day = v_day;
  update public.free_daily_users set used = used + 1, last_request_at = clock_timestamp()
    where day = v_day and user_id = p_user;
  return jsonb_build_object('allowed', true, 'used', v_used + 1, 'limit', 3,
    'global_available', v_global + 1 < 100, 'global_remaining', greatest(0, 99 - v_global), 'reset_at', v_reset);
end;
$$;
revoke all on function public.guest_quota(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.guest_quota(uuid, text, boolean) to service_role;

-- Deletes anonymous accounts with no sign-in or use for 7 days (cascades to their quota rows and saved reading),
-- and per-IP rows older than yesterday.
create or replace function public.cleanup_stale_guests()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from auth.users u
  where u.is_anonymous
    and greatest(u.created_at, coalesce(u.last_sign_in_at, u.created_at),
      coalesce((select a.last_used_at from public.guest_activity a where a.user_id = u.id), u.created_at)) < now() - interval '7 days';
  get diagnostics v_deleted = row_count;
  delete from public.free_guest_ip_daily where day < (clock_timestamp() at time zone 'Asia/Shanghai')::date - 1;
  return v_deleted;
end;
$$;
revoke all on function public.cleanup_stale_guests() from public, anon, authenticated;
grant execute on function public.cleanup_stale_guests() to service_role;

-- Fails the migration now (instead of silently later) if this role cannot delete from auth.users.
select public.cleanup_stale_guests();

-- Guests are cheap to create, so they must not be able to fill the shared 300 MiB conversation store
-- (which would wipe everyone's saved reading). Only real accounts keep a "上一局".
drop policy if exists chat_last_session_own on public.chat_last_session;
create policy chat_last_session_own on public.chat_last_session for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false);

-- Daily at 03:17 Beijing time, where pg_cron is available (Supabase hosted).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.unschedule(jobid) from cron.job where jobname = 'cleanup-stale-guests';
    perform cron.schedule('cleanup-stale-guests', '17 19 * * *', 'select public.cleanup_stale_guests()');
  end if;
end;
$$;

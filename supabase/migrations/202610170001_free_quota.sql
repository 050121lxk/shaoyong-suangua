-- Run once in Supabase SQL Editor or via `supabase db push`.
-- Quotas use Beijing civil days; serialize on the global row before touching a user row.
create table if not exists public.free_daily_global (
  day date primary key,
  used integer not null default 0 check (used between 0 and 100)
);
create table if not exists public.free_daily_users (
  day date not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  used integer not null default 0 check (used between 0 and 5),
  last_request_at timestamptz,
  primary key (day, user_id)
);
alter table public.free_daily_global enable row level security;
alter table public.free_daily_users enable row level security;
revoke all on public.free_daily_global, public.free_daily_users from anon, authenticated;

create or replace function public.free_quota(p_user uuid, p_consume boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (clock_timestamp() at time zone 'Asia/Shanghai')::date;
  v_global integer;
  v_used integer;
  v_last timestamptz;
  v_reset timestamptz := ((v_day + 1)::timestamp at time zone 'Asia/Shanghai');
begin
  if p_user is null then raise exception 'user required'; end if;
  if not p_consume then
    select used into v_global from public.free_daily_global where day = v_day;
    select used into v_used from public.free_daily_users where day = v_day and user_id = p_user;
    return jsonb_build_object('allowed', coalesce(v_used, 0) < 5 and coalesce(v_global, 0) < 100,
      'used', coalesce(v_used, 0), 'limit', 5, 'global_available', coalesce(v_global, 0) < 100, 'reset_at', v_reset);
  end if;

  insert into public.free_daily_global(day) values(v_day) on conflict do nothing;
  select used into v_global from public.free_daily_global where day = v_day for update;
  insert into public.free_daily_users(day, user_id) values(v_day, p_user) on conflict do nothing;
  select used, last_request_at into v_used, v_last from public.free_daily_users
    where day = v_day and user_id = p_user for update;

  if v_used >= 5 or v_global >= 100 then
    return jsonb_build_object('allowed', false, 'reason', case when v_used >= 5 then 'user_limit' else 'global_limit' end,
      'used', v_used, 'limit', 5, 'global_available', v_global < 100, 'reset_at', v_reset);
  end if;
  if v_last is not null and clock_timestamp() - v_last < interval '10 seconds' then
    return jsonb_build_object('allowed', false, 'reason', 'cooldown', 'used', v_used, 'limit', 5,
      'global_available', true, 'reset_at', v_reset);
  end if;

  update public.free_daily_global set used = used + 1 where day = v_day;
  update public.free_daily_users set used = used + 1, last_request_at = clock_timestamp()
    where day = v_day and user_id = p_user;
  return jsonb_build_object('allowed', true, 'used', v_used + 1, 'limit', 5,
    'global_available', v_global + 1 < 100, 'reset_at', v_reset);
end;
$$;

-- Only the Edge Function's service role may consume/read quotas. Clients cannot reset counters.
revoke all on function public.free_quota(uuid, boolean) from public, anon, authenticated;
grant execute on function public.free_quota(uuid, boolean) to service_role;

-- No automatic reset job: each day is a separate row. Older counters can be pruned manually.

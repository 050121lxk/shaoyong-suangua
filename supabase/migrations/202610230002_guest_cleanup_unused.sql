-- Guests count as "used" only when they actually send (viewing remaining quota no longer counts).
-- Guests that never sent anything are deleted after 1 day; guests that did send, after 7 idle days.
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

  insert into public.guest_activity(user_id, last_used_at) values (p_user, clock_timestamp())
    on conflict (user_id) do update set last_used_at = excluded.last_used_at;
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

-- Activity rows written by quota views under the previous version do not mean the guest was used.
delete from public.guest_activity a
where not exists (select 1 from public.free_daily_users d where d.user_id = a.user_id);

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
    and (
      -- Never sent anything: gone after 1 day.
      (not exists (select 1 from public.guest_activity a where a.user_id = u.id) and u.created_at < now() - interval '1 day')
      -- Sent before: gone after 7 idle days.
      or exists (select 1 from public.guest_activity a where a.user_id = u.id and a.last_used_at < now() - interval '7 days')
    );
  get diagnostics v_deleted = row_count;
  delete from public.free_guest_ip_daily where day < (clock_timestamp() at time zone 'Asia/Shanghai')::date - 1;
  return v_deleted;
end;
$$;
revoke all on function public.cleanup_stale_guests() from public, anon, authenticated;
grant execute on function public.cleanup_stale_guests() to service_role;

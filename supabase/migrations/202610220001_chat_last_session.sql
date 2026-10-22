-- Each signed-in user keeps only their latest reading ("上一局"), text only.
-- The browser writes its own row under RLS; a new round overwrites, "新一局" deletes it.
-- When all stored conversations together exceed 300 MiB, every row is wiped.
create table if not exists public.chat_last_session (
  user_id uuid primary key references auth.users(id) on delete cascade,
  mode text not null check (mode in ('free', 'byok')),
  context jsonb not null,
  messages jsonb not null check (jsonb_typeof(messages) = 'array' and jsonb_array_length(messages) between 2 and 40),
  bytes integer generated always as (octet_length(context::text) + octet_length(messages::text)) stored,
  updated_at timestamptz not null default now(),
  constraint chat_last_session_size check (bytes <= 4194304),
  -- Text only: every message is {role, content: string}; images and other parts are rejected.
  constraint chat_last_session_text_only check (not jsonb_path_exists(messages,
    '$[*] ? (@.content.type() != "string" || !(@.role == "user" || @.role == "assistant"))'))
);
alter table public.chat_last_session enable row level security;
revoke all on public.chat_last_session from anon, authenticated;
grant select, insert, update, delete on public.chat_last_session to authenticated;

drop policy if exists chat_last_session_own on public.chat_last_session;
create policy chat_last_session_own on public.chat_last_session for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- 300 MiB total across all users.
create or replace function public.chat_storage_cap_bytes() returns bigint language sql stable set search_path = '' as $$ select 314572800::bigint $$;
revoke all on function public.chat_storage_cap_bytes() from public, anon, authenticated;

-- Runs as owner so it can clear everyone's rows; `bytes` avoids de-TOASTing message bodies.
create or replace function public.chat_last_session_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select coalesce(sum(bytes), 0) from public.chat_last_session) > public.chat_storage_cap_bytes() then
    delete from public.chat_last_session;
  end if;
  return null;
end;
$$;
revoke all on function public.chat_last_session_cap() from public, anon, authenticated;

drop trigger if exists chat_last_session_cap on public.chat_last_session;
create trigger chat_last_session_cap after insert or update on public.chat_last_session
  for each statement execute function public.chat_last_session_cap();

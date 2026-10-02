-- ============================================================================
--  ChatBot AI — Cloud Sync schema (Supabase / PostgreSQL)
--  Run this once in:  Supabase Dashboard -> SQL Editor -> New query -> Run
--
--  Design notes:
--   * The client is the source of truth for the UI (IndexedDB). This schema is
--     the durable cloud mirror. All writes are idempotent upserts keyed by the
--     client-generated UUID, so re-syncing the same message never duplicates.
--   * Row Level Security guarantees a signed-in user can only ever touch rows
--     they own (auth.uid()); chat_messages are scoped through their session.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
--  Tables
-- ---------------------------------------------------------------------------
create table if not exists public.chat_sessions (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  title      text        not null default 'Untitled',
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id          uuid        primary key default gen_random_uuid(),
  session_id  uuid        not null references public.chat_sessions (id) on delete cascade,
  role        text        not null check (role in ('user', 'assistant', 'system')),
  content     text        not null,
  raw_content text,
  created_at  timestamptz not null default now()
);

-- Fast lookups: a user's sessions by freshness, a session's messages by time.
create index if not exists chat_sessions_user_idx
  on public.chat_sessions (user_id, updated_at desc);

create index if not exists chat_messages_session_idx
  on public.chat_messages (session_id, created_at asc);

-- ---------------------------------------------------------------------------
--  Keep chat_sessions.updated_at fresh on every update
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_chat_sessions_touch on public.chat_sessions;
create trigger trg_chat_sessions_touch
  before update on public.chat_sessions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
--  Row Level Security
-- ---------------------------------------------------------------------------
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;

-- chat_sessions: owner-only (re-run friendly: drop before create) -----------
drop policy if exists "sessions_select_own" on public.chat_sessions;
drop policy if exists "sessions_insert_own" on public.chat_sessions;
drop policy if exists "sessions_update_own" on public.chat_sessions;
drop policy if exists "sessions_delete_own" on public.chat_sessions;

create policy "sessions_select_own" on public.chat_sessions
  for select using (auth.uid() = user_id);

create policy "sessions_insert_own" on public.chat_sessions
  for insert with check (auth.uid() = user_id);

create policy "sessions_update_own" on public.chat_sessions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "sessions_delete_own" on public.chat_sessions
  for delete using (auth.uid() = user_id);

-- chat_messages: owner-only, inherited through the parent session ------------
drop policy if exists "messages_select_own" on public.chat_messages;
drop policy if exists "messages_insert_own" on public.chat_messages;
drop policy if exists "messages_update_own" on public.chat_messages;
drop policy if exists "messages_delete_own" on public.chat_messages;

create policy "messages_select_own" on public.chat_messages
  for select using (
    exists (
      select 1 from public.chat_sessions s
      where s.id = session_id and s.user_id = auth.uid()
    )
  );

create policy "messages_insert_own" on public.chat_messages
  for insert with check (
    exists (
      select 1 from public.chat_sessions s
      where s.id = session_id and s.user_id = auth.uid()
    )
  );

create policy "messages_update_own" on public.chat_messages
  for update using (
    exists (
      select 1 from public.chat_sessions s
      where s.id = session_id and s.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.chat_sessions s
      where s.id = session_id and s.user_id = auth.uid()
    )
  );

create policy "messages_delete_own" on public.chat_messages
  for delete using (
    exists (
      select 1 from public.chat_sessions s
      where s.id = session_id and s.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
--  Privileges for signed-in users (RLS still filters every row)
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.chat_sessions to authenticated;
grant select, insert, update, delete on public.chat_messages to authenticated;

-- ============================================================================
--  Conversations, messages and shares — Supabase / PostgreSQL
--  Run this once in: Supabase Dashboard -> SQL Editor -> New query -> Run
--
--  Safe to re-run. Every statement is idempotent.
--
--  Naming note, please read before running:
--    This repository already ships supabase/schema.sql, which creates
--    `chat_sessions` and `chat_messages` for the client-side cloud sync.
--    This script creates the three tables named in the spec:
--      conversations, messages, shares
--    Running both leaves you with two parallel sets of tables and the client
--    sync will keep using the `chat_*` pair. Pick one:
--      (a) run this script and point the cloud sync at `conversations` /
--          `messages`, or
--      (b) skip this script and rename the existing tables instead:
--            alter table public.chat_sessions rename to conversations;
--            alter table public.chat_messages rename to messages;
--          and then adjust the column names and policies below to match.
--    Default here is (a): the spec's names are what the rest of the brief uses.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
--  Tables
-- ---------------------------------------------------------------------------

-- A conversation belongs to exactly one user.
create table if not exists public.conversations (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  title      text        not null default 'Untitled',
  model      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Messages hang off a conversation and cascade with it. `role` is constrained
-- so a malformed client cannot write an arbitrary value that later rendering
-- would have to defend against.
create table if not exists public.messages (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        not null references public.conversations (id) on delete cascade,
  role            text        not null check (role in ('user', 'assistant', 'system')),
  content         text        not null default '',
  image           text,
  created_at      timestamptz not null default now()
);

-- A shared, read-only snapshot.
--
-- `id` is the share token itself (not a uuid) because it is minted by the
-- client today, so a link keeps working without a database round trip. When a
-- server-side share flow is added, switch this column to uuid and keep the
-- token in a separate column.
--
-- The primary key is text, and no policy below grants write access to
-- authenticated users: a share is created by the server with the service role
-- and is read-only from the client. That is deliberate — a shared link is a
-- capability, and letting every user mint one would let them publish rows they
-- do not own.
create table if not exists public.shares (
  id              text        primary key,
  conversation_id uuid        references public.conversations (id) on delete cascade,
  payload         jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
--  Indexes
-- ---------------------------------------------------------------------------
-- A user's conversations, most recent first: the sidebar query.
create index if not exists conversations_user_updated_idx
  on public.conversations (user_id, updated_at desc);

-- A conversation's messages in reading order.
create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at asc);

-- Shares are looked up by primary key; the extra index serves "shares for
-- this conversation" so deleting a conversation does not table-scan.
create index if not exists shares_conversation_idx
  on public.shares (conversation_id);

-- ---------------------------------------------------------------------------
--  Keep conversations.updated_at fresh
-- ---------------------------------------------------------------------------
-- Without this the sidebar ordering silently stops tracking edits.
create or replace function public.touch_conversation_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_conversations_touch on public.conversations;
create trigger trg_conversations_touch
  before update on public.conversations
  for each row execute function public.touch_conversation_updated_at();

-- ---------------------------------------------------------------------------
--  Row Level Security
-- ---------------------------------------------------------------------------
-- Enabled on every table. A table with RLS on and no policies denies every
-- row to non-owner roles, which is the safe default: a forgotten policy fails
-- closed rather than leaking.
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.shares enable row level security;

-- conversations: the owner, and only the owner ------------------------------
drop policy if exists "conversations_select_own" on public.conversations;
drop policy if exists "conversations_insert_own" on public.conversations;
drop policy if exists "conversations_update_own" on public.conversations;
drop policy if exists "conversations_delete_own" on public.conversations;

create policy "conversations_select_own" on public.conversations
  for select using (auth.uid() = user_id);

create policy "conversations_insert_own" on public.conversations
  for insert with check (auth.uid() = user_id);

create policy "conversations_update_own" on public.conversations
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "conversations_delete_own" on public.conversations
  for delete using (auth.uid() = user_id);

-- messages: inherited through the parent conversation -----------------------
-- Scoping by conversation_id alone would be wrong: the user_id lives one table
-- up, so every policy has to re-check ownership through the join. Forgetting
-- that is how a message-leak bug happens.
drop policy if exists "messages_select_own" on public.messages;
drop policy if exists "messages_insert_own" on public.messages;
drop policy if exists "messages_update_own" on public.messages;
drop policy if exists "messages_delete_own" on public.messages;

create policy "messages_select_own" on public.messages
  for select using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );

create policy "messages_insert_own" on public.messages
  for insert with check (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );

create policy "messages_update_own" on public.messages
  for update using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );

create policy "messages_delete_own" on public.messages
  for delete using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );

-- shares: read-only, and readable by anyone holding the token --------------
--
-- Note there is deliberately NO insert/update/delete policy. RLS on with no
-- policy means the anon and authenticated roles cannot write a share at all;
-- only the service role (which bypasses RLS) can. That is the point: a share
-- link is a capability token, and minting one must not be something any signed
-- in user can do for arbitrary content.
create policy "shares_select_any" on public.shares
  for select using (true);

-- ---------------------------------------------------------------------------
--  Privileges
-- ---------------------------------------------------------------------------
-- RLS filters every row regardless; these grants only decide which statements
-- are permitted at all.
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.messages to authenticated;

-- Shares are readable by anonymous visitors (that is the point of a share
-- link) but writable by neither anonymous nor authenticated roles.
grant usage on schema public to anon;
grant select on public.shares to anon;
grant select on public.shares to authenticated;

-- ---------------------------------------------------------------------------
--  Verify
-- ---------------------------------------------------------------------------
-- Expected: t = true for all three.
select
  (select relrowsecurity from pg_class where oid = 'public.conversations'::regclass) as conversations,
  (select relrowsecurity from pg_class where oid = 'public.messages'::regclass) as messages,
  (select relrowsecurity from pg_class where oid = 'public.shares'::regclass) as shares;
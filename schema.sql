-- Execute no SQL Editor do Supabase.
-- O Worker usa a chave service_role apenas como secret no Cloudflare.
create table if not exists public.nexus_messages (
  id bigint generated always as identity primary key,
  user_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists nexus_messages_user_created_idx
  on public.nexus_messages (user_id, created_at desc);

alter table public.nexus_messages enable row level security;

-- Não crie políticas públicas para esta tabela.
-- O Worker acessa a tabela pelo service_role guardado como secret.

-- Drop existing tables to clear previous constraints if re-running
drop table if exists public.email_embeddings cascade;
drop table if exists public.emails cascade;
drop table if exists public.email_threads cascade;
drop table if exists public.gmail_credentials cascade;

-- Enable the vector extension
create extension if not exists vector;

-- Enable uuid-ossp extension
create extension if not exists "uuid-ossp";

-- Table: gmail_credentials
create table if not exists public.gmail_credentials (
    id uuid primary key, -- Simplified for direct developer profile indexing
    email text not null,
    access_token text not null,
    refresh_token text not null,
    token_expiry timestamp with time zone not null,
    sync_status text default 'idle', -- 'idle', 'syncing', 'completed', 'failed'
    last_synced_at timestamp with time zone,
    last_history_id text,
    created_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone default now() not null
);

-- Table: email_threads
create table if not exists public.email_threads (
    id text primary key, -- Gmail Thread ID
    user_id uuid not null,
    subject text,
    summary text,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone default now() not null
);

-- Table: emails
create table if not exists public.emails (
    id text primary key, -- Gmail Message ID
    thread_id text references public.email_threads(id) on delete cascade not null,
    user_id uuid not null,
    subject text,
    from_name text,
    from_email text,
    to_emails text[] default '{}'::text[] not null,
    cc_emails text[] default '{}'::text[] not null,
    bcc_emails text[] default '{}'::text[] not null,
    body text,
    html_body text, -- Rich rendered HTML body content
    received_at timestamp with time zone,
    category text, -- 'Newsletters', 'Job / Recruitment', 'Finance', 'Notifications', 'Personal', 'Work / Professional'
    summary text,
    raw_headers jsonb,
    created_at timestamp with time zone default now() not null
);

-- Table: email_embeddings
create table if not exists public.email_embeddings (
    id uuid primary key default gen_random_uuid(),
    email_id text references public.emails(id) on delete cascade not null,
    thread_id text references public.email_threads(id) on delete cascade not null,
    user_id uuid not null,
    chunk_text text not null,
    embedding vector(768) not null, -- Gemini text-embedding-004
    created_at timestamp with time zone default now() not null
);

-- Enable RLS (Row Level Security) on all tables
alter table public.gmail_credentials enable row level security;
alter table public.email_threads enable row level security;
alter table public.emails enable row level security;
alter table public.email_embeddings enable row level security;

-- Setup RLS Policies (allows admin client bypass, and simplified user policies)
create policy "Allow all operations for development"
    on public.gmail_credentials
    for all
    using (true);

create policy "Allow all operations for threads"
    on public.email_threads
    for all
    using (true);

create policy "Allow all operations for emails"
    on public.emails
    for all
    using (true);

create policy "Allow all operations for embeddings"
    on public.email_embeddings
    for all
    using (true);

-- HNSW Vector Index for efficient similarity searches
create index if not exists email_embeddings_hnsw_idx 
    on public.email_embeddings 
    using hnsw (embedding vector_cosine_ops);

-- Indexing for speed
create index if not exists emails_thread_id_idx on public.emails (thread_id);
create index if not exists emails_category_idx on public.emails (category);
create index if not exists emails_received_idx on public.emails (received_at desc);

-- RPC: Match email embeddings for RAG
create or replace function public.match_email_embeddings (
    query_embedding vector(768),
    match_threshold float,
    match_count int,
    filter_user_id uuid,
    filter_category text default null,
    filter_sender text default null,
    filter_start_date timestamp with time zone default null,
    filter_end_date timestamp with time zone default null
)
returns table (
    id uuid,
    email_id text,
    thread_id text,
    chunk_text text,
    similarity float,
    subject text,
    from_name text,
    from_email text,
    received_at timestamp with time zone,
    category text
)
language plpgsql
stable
as $$
begin
    return query
    select
        ee.id,
        ee.email_id,
        ee.thread_id,
        ee.chunk_text,
        1 - (ee.embedding <=> query_embedding) as similarity,
        e.subject,
        e.from_name,
        e.from_email,
        e.received_at,
        e.category
    from public.email_embeddings ee
    join public.emails e on ee.email_id = e.id
    where ee.user_id = filter_user_id
      and (filter_category is null or e.category = filter_category)
      and (filter_sender is null or e.from_email ilike '%' || filter_sender || '%' or e.from_name ilike '%' || filter_sender || '%')
      and (filter_start_date is null or e.received_at >= filter_start_date)
      and (filter_end_date is null or e.received_at <= filter_end_date)
      and 1 - (ee.embedding <=> query_embedding) > match_threshold
    order by ee.embedding <=> query_embedding
    limit match_count;
end;
$$;

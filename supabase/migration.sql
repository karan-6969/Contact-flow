create table users(
  id uuid primary key default gen_random_uuid(),
  google_id text unique not null, email text, name text, avatar_url text,
  google_refresh_token text,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table contacts(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  google_resource_name text not null,
  name text not null, first_name text, last_name text, photo_url text,
  organization text, job_title text,
  emails jsonb not null default '[]', phones jsonb not null default '[]',
  favorite boolean not null default false,
  created_at timestamptz default now(), last_synced_at timestamptz default now(),
  unique(user_id, google_resource_name));
create index on contacts(user_id, name);
create table categories(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  name text not null, color text not null default '#5B5CE2', position int default 0,
  created_at timestamptz default now(), updated_at timestamptz default now());
create index on categories(user_id, position);
-- One category per contact in V1 (primary key on contact_id). Drop it to allow many.
create table contact_categories(
  contact_id uuid primary key references contacts on delete cascade,
  category_id uuid not null references categories on delete cascade,
  created_at timestamptz default now());
-- Server uses the service role key; RLS with no policies blocks all direct client access.
alter table users enable row level security;
alter table contacts enable row level security;
alter table categories enable row level security;
alter table contact_categories enable row level security;

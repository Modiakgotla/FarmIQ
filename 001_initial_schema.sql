-- ═══════════════════════════════════════════════════════════════
--  FarmIQ — Supabase Database Schema
--  Run this in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════════

-- ─── EXTENSION ────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ─── PROFILES ─────────────────────────────────────────────────────
-- Extends Supabase auth.users with FarmIQ-specific fields.
-- Automatically created when a user signs up (via trigger below).
create table if not exists public.profiles (
  id          uuid references auth.users(id) on delete cascade primary key,
  full_name   text,
  phone       text,
  province    text,
  plan        text not null default 'free',   -- 'free' | 'pro' | 'enterprise'
  analyses_this_month integer not null default 0,
  month_reset date not null default date_trunc('month', current_date),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Auto-create profile row on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Auto-update updated_at
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger profiles_updated_at before update on public.profiles
  for each row execute procedure public.touch_updated_at();

-- ─── FARMS ────────────────────────────────────────────────────────
create table if not exists public.farms (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references public.profiles(id) on delete cascade not null,
  name        text not null,
  lat         double precision not null,
  lng         double precision not null,
  province    text,
  size        text,
  crops       text,
  notes       text,
  last_score  integer,
  last_soil_type text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index farms_user_id_idx on public.farms(user_id);

create trigger farms_updated_at before update on public.farms
  for each row execute procedure public.touch_updated_at();

-- ─── REPORTS ──────────────────────────────────────────────────────
create table if not exists public.reports (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid references public.profiles(id) on delete cascade not null,
  farm_id       uuid references public.farms(id) on delete set null,
  lat           double precision not null,
  lng           double precision not null,
  farm_type     text not null default 'crops',  -- 'crops' | 'livestock'
  farm_size     text,
  score         integer,
  verdict       text,
  soil_type     text,
  soil_source   text,   -- 'ISRIC SoilGrids (live satellite)' | 'SA Regional...'
  soil_data     jsonb,  -- { ph, clay_pct, sand_pct, silt_pct, organic_carbon, nitrogen }
  climate_data  jsonb,  -- { current_temp, avg_max_temp, total_precip_90d, ... }
  recommendations jsonb, -- [{ id, label, emoji, score, factors }]
  advisory      text,
  selected_items text[], -- crop/livestock IDs that were selected
  created_at    timestamptz not null default now()
);

create index reports_user_id_idx  on public.reports(user_id);
create index reports_created_at_idx on public.reports(user_id, created_at desc);

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────
-- Critical: users can only read/write their OWN rows.

alter table public.profiles    enable row level security;
alter table public.farms       enable row level security;
alter table public.reports     enable row level security;

-- Profiles: users see and edit only their own profile
create policy "Users can view own profile"
  on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);

-- Farms: full CRUD on own farms only
create policy "Users can view own farms"
  on public.farms for select using (auth.uid() = user_id);
create policy "Users can insert own farms"
  on public.farms for insert with check (auth.uid() = user_id);
create policy "Users can update own farms"
  on public.farms for update using (auth.uid() = user_id);
create policy "Users can delete own farms"
  on public.farms for delete using (auth.uid() = user_id);

-- Reports: full CRUD on own reports only
create policy "Users can view own reports"
  on public.reports for select using (auth.uid() = user_id);
create policy "Users can insert own reports"
  on public.reports for insert with check (auth.uid() = user_id);
create policy "Users can delete own reports"
  on public.reports for delete using (auth.uid() = user_id);

-- ─── USAGE RESET FUNCTION ─────────────────────────────────────────
-- Call this (or use a cron job) to reset monthly analysis counts.
create or replace function public.reset_monthly_usage()
returns void language plpgsql security definer as $$
begin
  update public.profiles
  set analyses_this_month = 0,
      month_reset = date_trunc('month', current_date)
  where month_reset < date_trunc('month', current_date);
end;
$$;

-- ─── HELPFUL VIEW ─────────────────────────────────────────────────
-- Convenient joined view for the dashboard (respects RLS via profiles policy)
create or replace view public.user_dashboard as
  select
    p.id,
    p.full_name,
    p.plan,
    p.analyses_this_month,
    count(distinct f.id)   as farm_count,
    count(distinct r.id)   as report_count,
    max(r.score)           as best_score,
    max(r.created_at)      as last_analysis_at
  from public.profiles p
  left join public.farms   f on f.user_id = p.id
  left join public.reports r on r.user_id = p.id
  where p.id = auth.uid()
  group by p.id, p.full_name, p.plan, p.analyses_this_month;

-- Done! Check Supabase Dashboard → Table Editor to confirm tables were created.

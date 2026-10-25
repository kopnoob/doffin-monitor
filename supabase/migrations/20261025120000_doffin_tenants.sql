-- Én nøkkel per leietaker (commit, rebase, accelat). Sidene sender nøkkelen i
-- headeren x-doffin-key; databasen lagrer bare SHA-256 av den. Anon-nøkkelen
-- alene gir ingen tilgang lenger (se 20261025130000_doffin_tenants_tighten.sql).

create table if not exists public.doffin_tenants (
  tenant      text primary key check (tenant in ('commit', 'rebase', 'accelat')),
  key_sha256  text not null unique check (key_sha256 ~ '^[0-9a-f]{64}$')
);

-- RLS uten policies: bare service role (edge-funksjonene) og postgres leser den.
alter table public.doffin_tenants enable row level security;
revoke all on public.doffin_tenants from anon, authenticated;

-- Hvilken leietaker hører nøkkelen i x-doffin-key til? null hvis ingen.
-- security definer fordi anon ikke kan lese doffin_tenants. Alle navn er
-- skjemakvalifisert (ingen search_path i funksjonen).
create or replace function public.doffin_tenant()
returns text
language sql
stable
security definer
as $$
  select t.tenant
  from public.doffin_tenants t
  where t.key_sha256 = pg_catalog.encode(
    extensions.digest(
      nullif(pg_catalog.current_setting('request.headers', true), '')::json ->> 'x-doffin-key',
      'sha256'
    ),
    'hex'
  )
$$;

revoke all on function public.doffin_tenant() from public;
grant execute on function public.doffin_tenant() to anon, authenticated, service_role;

-- Nye leietakerpolicyer. De gamle «allow all»-policyene fjernes i neste migrering,
-- når alle tre sidene sender nøkkelen.

-- Commit: CPV-koder og statuser/kommentarer
create policy "doffin commit" on public.cpv_codes
  for all to anon, authenticated
  using ((select public.doffin_tenant()) = 'commit')
  with check ((select public.doffin_tenant()) = 'commit');

create policy "doffin commit" on public.user_notices
  for all to anon, authenticated
  using ((select public.doffin_tenant()) = 'commit')
  with check ((select public.doffin_tenant()) = 'commit');

-- AI-analysene gjelder offentlige kunngjøringer og leses av både Commit og Rebase.
-- Bare claude-analysis (service role) skriver dem.
create policy "doffin les commit rebase" on public.ai_analyses
  for select to anon, authenticated
  using ((select public.doffin_tenant()) in ('commit', 'rebase'));

-- Accelat
create policy "doffin accelat" on public.accelat_cpv_codes
  for all to anon, authenticated
  using ((select public.doffin_tenant()) = 'accelat')
  with check ((select public.doffin_tenant()) = 'accelat');

create policy "doffin accelat" on public.accelat_user_notices
  for all to anon, authenticated
  using ((select public.doffin_tenant()) = 'accelat')
  with check ((select public.doffin_tenant()) = 'accelat');

-- notice_cache leses og skrives bare av doffin-proxy og doffin-proxy-open med
-- service role, så den får ingen policy for anon.

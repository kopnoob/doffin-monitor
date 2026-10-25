-- Steng anon-nøkkelen ute: de gamle «allow all»-policyene fjernes, slik at bare
-- leietakerpolicyene fra 20261025120000_doffin_tenants.sql gjelder.
--   cpv_codes, user_notices        → commit
--   ai_analyses (bare lesing)      → commit og rebase
--   accelat_cpv_codes, accelat_user_notices → accelat
--   notice_cache                   → ingen (bare edge-funksjonene, med service role)
--   claude_tasks, doffin_tenants   → ingen (som før)

drop policy if exists "Allow all on cpv_codes" on public.cpv_codes;
drop policy if exists "Allow all on user_notices" on public.user_notices;
drop policy if exists "Allow anon access" on public.ai_analyses;
drop policy if exists "Allow all on notice_cache" on public.notice_cache;
drop policy if exists "anon all accelat_cpv_codes" on public.accelat_cpv_codes;
drop policy if exists "anon all accelat_user_notices" on public.accelat_user_notices;

# Doffin Monitor (Commit)

**Flyttet og stengt 25.10.2026.** Siden ligger nå på https://prosjekt.commit.no/salg/doffin/ (bak Commit-innlogging, rollen «salg»), og GitHub Pages-siden kopnoob.github.io/doffin-monitor er slått av.

Repoet beholdes fordi edge-funksjonene og migreringene til Supabase-prosjektet `doffin-monitor` (gicioyjyyoxlqaiqziwh) ligger her, i `supabase/`. De deles av Commit, Rebase (prosjekt.commit.no/salg/rebase/) og Accelat (kopnoob/doffin-monitor-accelat). Hver leietaker har sin egen nøkkel i headeren `x-doffin-key`; anon-nøkkelen alene gir ingen tilgang (se `supabase/functions/_shared/tenant.ts` og `supabase/migrations/20261025*_doffin_tenants*.sql`).

Rull ut funksjonene med `supabase functions deploy <navn> --project-ref gicioyjyyoxlqaiqziwh --no-verify-jwt`.

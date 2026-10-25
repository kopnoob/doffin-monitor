import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2"

// Leietakernøkkelen: sidene sender x-doffin-key, og vi slår opp SHA-256 av den i
// public.doffin_tenants (lukket for anon, leses her med service role).
//   commit  – prosjekt.commit.no/salg/doffin/
//   rebase  – prosjekt.commit.no/salg/rebase/
//   accelat – kopnoob.github.io/doffin-monitor-accelat/
// Anon-nøkkelen alene gir ingenting: uten gyldig nøkkel svarer funksjonene 401,
// og med en nøkkel funksjonen ikke er åpen for, 403.

export type Tenant = "commit" | "rebase" | "accelat"

export const DOFFIN_KEY_HEADER = "x-doffin-key"

// Var false en kort stund 25.10.2026 mens sidene ble lagt om til å sende nøkkelen.
export const REQUIRE_KEY = true

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

export async function tenantFor(req: Request, sb: SupabaseClient): Promise<Tenant | null> {
  const key = req.headers.get(DOFFIN_KEY_HEADER)
  if (!key) return null
  const { data, error } = await sb
    .from("doffin_tenants")
    .select("tenant")
    .eq("key_sha256", await sha256Hex(key))
    .maybeSingle()
  if (error) throw new Error("Kunne ikke sjekke nøkkelen: " + error.message)
  return (data?.tenant as Tenant | undefined) ?? null
}

/**
 * Sjekker nøkkelen mot de leietakerne funksjonen er åpen for. Gir en ferdig
 * feilrespons (401/403) når kallet skal avvises, ellers leietakeren (null bare
 * når REQUIRE_KEY er av og kallet kom uten gyldig nøkkel).
 */
export async function authorize(
  req: Request,
  sb: SupabaseClient,
  allowed: Tenant[],
  corsHeaders: Record<string, string>,
): Promise<{ tenant: Tenant | null; denied?: Response }> {
  const tenant = await tenantFor(req, sb)
  const deny = (status: number, error: string) => ({
    tenant,
    denied: new Response(JSON.stringify({ error }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
    }),
  })
  if (!tenant) {
    if (!REQUIRE_KEY) {
      console.warn("Kall uten gyldig x-doffin-key (tillatt i overgangen)")
      return { tenant: null }
    }
    return deny(401, "Mangler gyldig x-doffin-key")
  }
  if (!allowed.includes(tenant)) return deny(403, "Nøkkelen gir ikke tilgang til denne funksjonen")
  return { tenant }
}

import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const DOFFIN_NOTICE_URL = "https://api.doffin.no/webclient/api/v2/notices-api/notices"
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const ANALYSIS_PROMPT = `Du er en ekspert på offentlige anskaffelser i Norge og IT-konsulentbransjen. Analyser denne kunngjøringen og vurder om den ber om:

A) Et ferdig SaaS-produkt som skal tilpasses/konfigureres for kunden
B) Noe som realistisk kan utvikles fra scratch av et lite utviklerteam (2-5 personer)
C) Uklart / kan gå begge veier

Svar i JSON-format (kun JSON, ingen markdown):
{
  "verdict": "existing_saas" | "build_from_scratch" | "ambiguous",
  "confidence": "high" | "medium" | "low",
  "summary": "Kort oppsummering av hva kunden egentlig trenger (1-2 setninger)",
  "saas_competitors": ["Liste over eksisterende SaaS-produkter som typisk vinner slike konkurranser, f.eks. Visma, Unit4, ServiceNow etc. Tom liste hvis verdict er build_from_scratch"],
  "buildability_note": "Hvis dette kan bygges fra scratch: hva er kjernefunksjonaliteten, og hva er estimert kompleksitet (lav/middels/hoy)? Hvis SaaS: hvorfor er det urealistisk a bygge fra scratch?",
  "reasoning": "Kort begrunnelse for vurderingen"
}

Her er kunngjøringen:
`

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }

  try {
    const { notice_id } = await req.json()
    if (!notice_id) {
      return new Response(
        JSON.stringify({ error: "notice_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    )

    // Check cache first
    const { data: cached } = await supabase
      .from("ai_analyses")
      .select("*")
      .eq("notice_id", notice_id)
      .single()

    if (cached) {
      return new Response(
        JSON.stringify(cached),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Fetch full notice details from Doffin
    const noticeRes = await fetch(`${DOFFIN_NOTICE_URL}/${notice_id}`)
    if (!noticeRes.ok) {
      throw new Error(`Failed to fetch notice: ${noticeRes.status}`)
    }
    const notice = await noticeRes.json()

    // Build context for Claude
    const heading = notice.heading || "(Uten tittel)"
    const description = notice.description || "(Ingen beskrivelse)"
    const buyer = (notice.buyer || []).map((b: { name: string }) => b.name).join(", ") || "Ukjent"
    const estimatedValue = notice.estimatedValue?.amount
      ? `${Number(notice.estimatedValue.amount).toLocaleString("nb-NO")} NOK`
      : "Ikke oppgitt"
    const cpvCodes = (notice.cpvCodes || []).join(", ") || "Ikke oppgitt"

    const noticeContext = `
Tittel: ${heading}
Oppdragsgiver: ${buyer}
Estimert verdi: ${estimatedValue}
CPV-koder: ${cpvCodes}

Beskrivelse:
${description}
`.trim()

    // Call Anthropic API
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")
    if (!anthropicKey) {
      throw new Error("ANTHROPIC_API_KEY not configured")
    }

    const claudeRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: ANALYSIS_PROMPT + noticeContext
        }],
      }),
    })

    if (!claudeRes.ok) {
      const errText = await claudeRes.text()
      throw new Error(`Anthropic API error: ${claudeRes.status} - ${errText}`)
    }

    const claudeData = await claudeRes.json()
    const responseText = claudeData.content?.[0]?.text || "{}"

    let analysis
    try {
      analysis = JSON.parse(responseText)
    } catch {
      analysis = {
        verdict: "ambiguous",
        confidence: "low",
        summary: responseText,
        saas_competitors: [],
        buildability_note: "",
        reasoning: "Kunne ikke parse strukturert svar fra AI"
      }
    }

    // Cache the result
    const row = {
      notice_id,
      analysis,
      model: "claude-sonnet-4-20250514",
      created_at: new Date().toISOString(),
    }

    await supabase
      .from("ai_analyses")
      .upsert(row, { onConflict: "notice_id" })

    return new Response(
      JSON.stringify(row),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})

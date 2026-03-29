import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const DOFFIN_SEARCH_URL = "https://api.doffin.no/webclient/api/v2/search-api/search"
const DOFFIN_NOTICE_URL = "https://api.doffin.no/webclient/api/v2/notices-api/notices"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
}

function buildRequestBody(page: number, cpvCodes: string[]) {
  return {
    numHitsPerPage: 100,
    page,
    searchString: "",
    sortBy: "RELEVANCE",
    facets: {
      cpvCodesLabel: { checkedItems: [] },
      cpvCodesId: { checkedItems: cpvCodes },
      type: { checkedItems: ["ANNOUNCEMENT_OF_COMPETITION"] },
      status: { checkedItems: ["ACTIVE"] },
      contractNature: { checkedItems: ["SERVICES"] },
      publicationDate: { from: null, to: null },
      location: { checkedItems: [] },
      buyer: { checkedItems: [] },
      winner: { checkedItems: [] },
    },
  }
}

interface EformSection {
  title: string
  label: string | null
  value: string | null
  sections: EformSection[] | null
}

function findInternalId(eform: EformSection[]): string | null {
  for (const block of eform) {
    if ((block.label === "Intern identifikator" || block.label === "Internal identifier") && block.value) {
      return block.value
    }
    if (block.sections) {
      const found = findInternalId(block.sections)
      if (found) return found
    }
  }
  return null
}

// Keyword-based classification of notices into "rammeavtale" or "system"
function classifyNotice(hit: { heading?: string; description?: string }): "rammeavtale" | "system" {
  const text = ((hit.heading || '') + ' ' + (hit.description || '')).toLowerCase()

  // Negative signals: if these system-specific terms are present, skip rammeavtale classification
  const systemSignals = [
    'fagsystem', 'plattform', 'programvare', 'lisens',
    'saas', 'skyløsning', 'applikasjon', 'selvbetjening',
    'kontaktsenter', 'læringsplattform', 'styringssystem'
  ]
  const hasSystemSignal = systemSignals.some(s => text.includes(s))

  if (!hasSystemSignal) {
    const hasRammeavtale = text.includes('rammeavtale')

    const consultantTerms = [
      'konsulent', 'innleie', 'bistand', 'rådgiv',
      'ekstern kompetanse', 'spisskompetanse', 'ressurs',
      'formidling'
    ]
    const itTerms = [
      'ikt', 'it-', 'it ', 'digital', 'teknologi', 'utvikling',
      'modernisering', 'data', 'cyber', 'sikkerhet', 'arkitektur'
    ]

    const hasConsultantTerm = consultantTerms.some(t => text.includes(t))
    const hasItTerm = itTerms.some(t => text.includes(t))

    if (hasRammeavtale && hasConsultantTerm) return 'rammeavtale'
    if (hasRammeavtale && hasItTerm) return 'rammeavtale'
    if (text.includes('konsulenttjenester') && hasRammeavtale) return 'rammeavtale'
    if (text.includes('konsulentbistand')) return 'rammeavtale'
    if (text.includes('konsulenttjenester') && hasItTerm) return 'rammeavtale'
    if (text.includes('rådgivningstjenester') && hasItTerm) return 'rammeavtale'
  }

  return 'system'
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    )

    // Get CPV codes
    const { data: cpvRows } = await supabase
      .from("cpv_codes")
      .select("code")
      .order("code")
    const cpvCodes = (cpvRows || []).map((r: { code: string }) => r.code)

    if (cpvCodes.length === 0) {
      return new Response(
        JSON.stringify({ numHitsTotal: 0, hits: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Fetch all ANNOUNCEMENT_OF_COMPETITION pages
    const firstRes = await fetch(DOFFIN_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRequestBody(1, cpvCodes)),
    })
    if (!firstRes.ok) throw new Error(`Doffin API error: ${firstRes.status}`)

    const firstData = await firstRes.json()
    const allHits = [...firstData.hits]
    const totalPages = Math.ceil(firstData.numHitsTotal / 100)

    if (totalPages > 1) {
      const promises = []
      for (let page = 2; page <= totalPages; page++) {
        promises.push(
          fetch(DOFFIN_SEARCH_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildRequestBody(page, cpvCodes)),
          }).then(r => {
            if (!r.ok) throw new Error(`Page ${page}: ${r.status}`)
            return r.json()
          })
        )
      }
      for (const pageData of await Promise.all(promises)) {
        allHits.push(...pageData.hits)
      }
    }

    // Exclude notices that are confirmed DPS in cache
    const allIds = allHits.map((h: { id: string }) => h.id)
    const { data: cacheRows } = await supabase
      .from("notice_cache")
      .select("notice_id, is_dps, internal_id, competition_docs_url")
      .in("notice_id", allIds)

    const cache: Record<string, { is_dps: boolean; internal_id: string | null; competition_docs_url: string | null }> = {}
    for (const row of cacheRows || []) {
      cache[row.notice_id] = row
    }

    const dpsIds = new Set(
      (cacheRows || []).filter(r => r.is_dps).map(r => r.notice_id)
    )

    // Filter out DPS notices — they belong in doffin-proxy, not here
    const filtered = allHits.filter((h: { id: string }) => !dpsIds.has(h.id))

    // Enrich from cache, fetch details for uncached
    const uncached = filtered.filter((h: { id: string }) => !(h.id in cache))
    if (uncached.length > 0) {
      const BATCH = 20
      for (let i = 0; i < uncached.length; i += BATCH) {
        const batch = uncached.slice(i, i + BATCH)
        const details = await Promise.all(
          batch.map((h: { id: string }) =>
            fetch(`${DOFFIN_NOTICE_URL}/${h.id}`)
              .then(r => r.ok ? r.json() : null)
              .catch(() => null)
          )
        )
        const rows: { notice_id: string; is_dps: boolean; internal_id: string | null; competition_docs_url: string | null; checked_at: string }[] = []
        for (let j = 0; j < batch.length; j++) {
          const detail = details[j]
          const row = {
            notice_id: batch[j].id,
            is_dps: false,
            internal_id: detail?.eform ? findInternalId(detail.eform) : null,
            competition_docs_url: detail?.competitionDocsUrl || null,
            checked_at: new Date().toISOString(),
          }
          rows.push(row)
          cache[batch[j].id] = row
        }
        if (rows.length > 0) {
          await supabase.from("notice_cache").upsert(rows, { onConflict: "notice_id" })
        }
      }
    }

    // Enrich hits from cache and classify
    for (const hit of filtered) {
      const c = cache[hit.id]
      if (c) {
        hit.internalId = c.internal_id
        hit.competitionDocsUrl = c.competition_docs_url
      }
      hit.category = classifyNotice(hit)
    }

    return new Response(
      JSON.stringify({ numHitsTotal: filtered.length, hits: filtered }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})

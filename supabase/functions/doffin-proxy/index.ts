import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const DOFFIN_SEARCH_URL = "https://api.doffin.no/webclient/api/v2/search-api/search"
const DOFFIN_NOTICE_URL = "https://api.doffin.no/webclient/api/v2/notices-api/notices"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
}

// ── Doffin search helpers ───────────────────────────

function buildSearchBody(page: number, cpvCodes: string[], typeFilter: string[]) {
  return {
    numHitsPerPage: 100,
    page,
    searchString: "",
    sortBy: "RELEVANCE",
    facets: {
      cpvCodesLabel: { checkedItems: [] },
      cpvCodesId: { checkedItems: cpvCodes },
      type: { checkedItems: typeFilter },
      status: { checkedItems: ["ACTIVE"] },
      contractNature: { checkedItems: ["SERVICES"] },
      publicationDate: { from: null, to: null },
      location: { checkedItems: [] },
      buyer: { checkedItems: [] },
      winner: { checkedItems: [] },
    },
  }
}

async function fetchAllPages(cpvCodes: string[], typeFilter: string[]) {
  const firstRes = await fetch(DOFFIN_SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildSearchBody(1, cpvCodes, typeFilter)),
  })
  if (!firstRes.ok) throw new Error(`Doffin API error: ${firstRes.status}`)

  const firstData = await firstRes.json()
  const hits = [...firstData.hits]
  const totalPages = Math.ceil(firstData.numHitsTotal / 100)

  if (totalPages > 1) {
    const promises = []
    for (let page = 2; page <= totalPages; page++) {
      promises.push(
        fetch(DOFFIN_SEARCH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildSearchBody(page, cpvCodes, typeFilter)),
        }).then(r => {
          if (!r.ok) throw new Error(`Doffin page ${page}: ${r.status}`)
          return r.json()
        })
      )
    }
    for (const pageData of await Promise.all(promises)) {
      hits.push(...pageData.hits)
    }
  }
  return hits
}

// ── Eform parsing ───────────────────────────────────

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

function isRealDps(eform: EformSection[]): boolean {
  for (const block of eform) {
    const label = (block.label || "").toLowerCase()
    const value = (block.value || "").toLowerCase()
    if (label.includes("dynamisk innkjøpsordning") && value && value.trim()) return true
    if (label.includes("dynamic purchasing") && value && value.trim()) return true
    if (value.includes("dynamisk innkjøpsordning")) return true
    if (value.includes("dynamic purchasing")) return true
    if (block.sections && isRealDps(block.sections)) return true
  }
  return false
}

// ── Notice detail fetcher ───────────────────────────

interface NoticeDetail {
  internalId: string | null
  competitionDocsUrl: string | null
  isDps: boolean
}

async function fetchNoticeDetail(id: string): Promise<NoticeDetail | null> {
  try {
    const res = await fetch(`${DOFFIN_NOTICE_URL}/${id}`)
    if (!res.ok) return null
    const d = await res.json()
    const eform = d.eform || []
    return {
      internalId: findInternalId(eform),
      competitionDocsUrl: d.competitionDocsUrl || null,
      isDps: isRealDps(eform),
    }
  } catch {
    return null
  }
}

// ── Main handler ────────────────────────────────────

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

    // ── Step 1: Two parallel searches ───────────────
    const [dpsHits, allHits] = await Promise.all([
      fetchAllPages(cpvCodes, ["DYNAMIC_PURCHASING_SCHEME"]),
      fetchAllPages(cpvCodes, []),
    ])

    const dpsIds = new Set(dpsHits.map((h: { id: string }) => h.id))
    // Candidates: in broad search but not in DPS search
    const candidateHits = allHits.filter((h: { id: string }) => !dpsIds.has(h.id))

    // ── Step 2: Load cache ──────────────────────────
    const allIds = [...dpsHits, ...candidateHits].map((h: { id: string }) => h.id)
    const { data: cacheRows } = await supabase
      .from("notice_cache")
      .select("*")
      .in("notice_id", allIds)

    const cache: Record<string, {
      is_dps: boolean
      internal_id: string | null
      competition_docs_url: string | null
    }> = {}
    for (const row of cacheRows || []) {
      cache[row.notice_id] = row
    }

    // ── Step 3: Fetch details for uncached notices ──
    const uncachedIds = allIds.filter(id => !(id in cache))

    if (uncachedIds.length > 0) {
      const BATCH = 20
      for (let i = 0; i < uncachedIds.length; i += BATCH) {
        const batch = uncachedIds.slice(i, i + BATCH)
        const details = await Promise.all(batch.map(id => fetchNoticeDetail(id)))

        const rows: {
          notice_id: string
          is_dps: boolean
          internal_id: string | null
          competition_docs_url: string | null
          checked_at: string
        }[] = []

        for (let j = 0; j < batch.length; j++) {
          const detail = details[j]
          const id = batch[j]
          const isDpsTagged = dpsIds.has(id)
          const row = {
            notice_id: id,
            is_dps: isDpsTagged || (detail?.isDps ?? false),
            internal_id: detail?.internalId ?? null,
            competition_docs_url: detail?.competitionDocsUrl ?? null,
            checked_at: new Date().toISOString(),
          }
          rows.push(row)
          cache[id] = row
        }

        if (rows.length > 0) {
          await supabase.from("notice_cache").upsert(rows, { onConflict: "notice_id" })
        }
      }
    }

    // ── Step 4: Build result set ────────────────────
    // DPS-tagged hits: always include, enrich from cache
    const resultHits = dpsHits.map((h: Record<string, unknown>) => {
      const c = cache[h.id as string]
      return {
        ...h,
        internalId: c?.internal_id ?? null,
        competitionDocsUrl: c?.competition_docs_url ?? null,
        mistagged: false,
      }
    })

    // Mistagged DPS: candidates confirmed as DPS via eform
    for (const h of candidateHits) {
      const c = cache[h.id]
      if (c?.is_dps) {
        resultHits.push({
          ...h,
          internalId: c.internal_id ?? null,
          competitionDocsUrl: c.competition_docs_url ?? null,
          mistagged: true,
        })
      }
    }

    return new Response(
      JSON.stringify({ numHitsTotal: resultHits.length, hits: resultHits }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})

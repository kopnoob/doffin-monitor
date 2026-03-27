import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const DOFFIN_API_URL = "https://api.doffin.no/webclient/api/v2/search-api/search"
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
      type: { checkedItems: ["DYNAMIC_PURCHASING_SCHEME"] },
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
    if (block.label === "Intern identifikator" && block.value) {
      return block.value
    }
    if (block.label === "Internal identifier" && block.value) {
      return block.value
    }
    if (block.sections) {
      const found = findInternalId(block.sections)
      if (found) return found
    }
  }
  return null
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

    // Get CPV codes from database
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

    // Fetch first page
    const firstRes = await fetch(DOFFIN_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRequestBody(1, cpvCodes)),
    })

    if (!firstRes.ok) {
      throw new Error(`Doffin API error: ${firstRes.status}`)
    }

    const firstData = await firstRes.json()
    const allHits = [...firstData.hits]
    const totalHits = firstData.numHitsTotal
    const totalPages = Math.ceil(totalHits / 100)

    // Fetch remaining pages in parallel
    if (totalPages > 1) {
      const pagePromises = []
      for (let page = 2; page <= totalPages; page++) {
        pagePromises.push(
          fetch(DOFFIN_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildRequestBody(page, cpvCodes)),
          }).then((res) => {
            if (!res.ok) throw new Error(`Doffin page ${page}: ${res.status}`)
            return res.json()
          })
        )
      }
      const pageResults = await Promise.all(pagePromises)
      for (const pageData of pageResults) {
        allHits.push(...pageData.hits)
      }
    }

    // Fetch internal identifiers for all hits in parallel (batched)
    const BATCH_SIZE = 20
    for (let i = 0; i < allHits.length; i += BATCH_SIZE) {
      const batch = allHits.slice(i, i + BATCH_SIZE)
      const detailPromises = batch.map((hit: { id: string }) =>
        fetch(`${DOFFIN_NOTICE_URL}/${hit.id}`)
          .then(res => res.ok ? res.json() : null)
          .catch(() => null)
      )
      const details = await Promise.all(detailPromises)
      for (let j = 0; j < batch.length; j++) {
        const detail = details[j]
        if (detail?.eform) {
          const internalId = findInternalId(detail.eform)
          if (internalId) {
            allHits[i + j].internalId = internalId
          }
        }
      }
    }

    return new Response(
      JSON.stringify({ numHitsTotal: totalHits, hits: allHits }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})

import "@supabase/functions-js/edge-runtime.d.ts"
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2"
import { authorize } from "../_shared/tenant.ts"
import {
  applyEvent,
  cleanNote,
  DEFAULT_NOTES,
  EVENT_CONFIRMATIONS,
  EVENT_NAMES,
  isEventName,
  NOTICE_ID_RE,
  NoticeState,
  TOKEN_RE,
} from "./events.ts"

// claude-task — enveis statuskanal fra Claude til Doffin Monitor.
//
// Dashboardet oppretter en oppgave (POST action=create) med en tilfeldig
// nøkkel som også legges i prompten brukeren limer inn i sin egen Claude.
// Claude rapporterer så fremdrift ved å åpne ferdiglagde lenker:
//
//   GET  /functions/v1/claude-task?t=<nøkkel>&e=<hendelse>[&note=<tekst>]
//   POST /functions/v1/claude-task  {"token":"…","event":"…","note":"…"}
//
// GET støttes fordi web_fetch i claude.ai kun gjør GET mot lenker som står i
// meldingen. Funksjonen må derfor deployes uten JWT-krav (verify_jwt = false);
// nøkkelen er autentiseringen og gir bare tilgang til én kunngjøring.
//
// Å opprette en oppgave krever i tillegg Commit sin leietakernøkkel i
// x-doffin-key (se _shared/tenant.ts). Statushendelsene fra Claude har bare
// engangsnøkkelen, for Claude kan ikke sende egne headere.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-doffin-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
}

function text(body: string, status = 200) {
  return new Response(body + "\n", {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  })
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}

const HELP = `Doffin Monitor – Claude-statuskanal.
Bruk: ?t=<nøkkel>&e=<hendelse>[&note=<kort tekst>]
Hendelser: ${EVENT_NAMES.join(", ")}`

interface UserNoticeRow extends NoticeState {
  notice_id: string
  comment: string | null
}

async function getUserNotice(sb: SupabaseClient, noticeId: string): Promise<UserNoticeRow | null> {
  const { data, error } = await sb
    .from("user_notices")
    .select("notice_id, status, sub_status, comment, claude_state")
    .eq("notice_id", noticeId)
    .maybeSingle()
  if (error) throw new Error("Kunne ikke lese user_notices: " + error.message)
  return data as UserNoticeRow | null
}

/** Oppdaterer eksisterende rad, eller oppretter en ny uten å røre kommentaren. */
async function writeUserNotice(
  sb: SupabaseClient,
  noticeId: string,
  existing: UserNoticeRow | null,
  fields: Record<string, unknown>,
) {
  const now = new Date().toISOString()
  const row = { ...fields, claude_updated_at: now, updated_at: now }
  const { error } = existing
    ? await sb.from("user_notices").update(row).eq("notice_id", noticeId)
    : await sb.from("user_notices").insert({
      notice_id: noticeId,
      status: null,
      comment: "",
      ...row,
    })
  if (error) throw new Error("Kunne ikke skrive user_notices: " + error.message)
}

// ── Opprett oppgave (kalles av dashboardet) ─────────

async function createTask(sb: SupabaseClient, token: string, noticeId: string) {
  if (!TOKEN_RE.test(token)) return json({ error: "Ugyldig nøkkel" }, 400)
  if (!NOTICE_ID_RE.test(noticeId)) return json({ error: "Ugyldig notice_id" }, 400)

  const { error } = await sb.from("claude_tasks").insert({ token, notice_id: noticeId })
  if (error) {
    if (error.code === "23505") return json({ error: "Nøkkelen finnes allerede" }, 409)
    throw new Error("Kunne ikke opprette oppgave: " + error.message)
  }

  const existing = await getUserNotice(sb, noticeId)
  // Ikke overstyr en Claude-økt som allerede er i gang.
  const active = existing?.claude_state === "working" || existing?.claude_state === "waiting"
  if (!active) {
    await writeUserNotice(sb, noticeId, existing, {
      claude_state: "queued",
      claude_note: "Prompt kopiert – venter på at Claude starter",
    })
  }
  return json({ ok: true, notice_id: noticeId })
}

// ── Statushendelse (kalles av Claude) ───────────────

async function handleEvent(sb: SupabaseClient, token: string, event: string | null, note: string | null) {
  if (!TOKEN_RE.test(token)) return text("FEIL: Ugyldig nøkkel.\n\n" + HELP, 400)

  const { data: task, error } = await sb
    .from("claude_tasks")
    .select("token, notice_id, expires_at, events")
    .eq("token", token)
    .maybeSingle()
  if (error) throw new Error("Kunne ikke lese oppgave: " + error.message)
  if (!task) return text("FEIL: Ukjent nøkkel. Be brukeren kopiere en ny prompt fra Doffin Monitor.", 404)
  if (new Date(task.expires_at) < new Date()) {
    return text("FEIL: Nøkkelen er utløpt. Be brukeren kopiere en ny prompt fra Doffin Monitor.", 410)
  }

  const existing = await getUserNotice(sb, task.notice_id)

  // Uten hendelse: bare rapporter nåværende status.
  if (!event) {
    return text(
      `OK – kunngjøring ${task.notice_id}: status=${existing?.status ?? "ny"}, ` +
        `substatus=${existing?.sub_status ?? "-"}, claude=${existing?.claude_state ?? "-"}`,
    )
  }
  if (!isEventName(event)) return text(`FEIL: Ukjent hendelse «${event}».\n\n` + HELP, 400)

  const patch = applyEvent(event, {
    status: existing?.status ?? null,
    sub_status: existing?.sub_status ?? null,
    claude_state: existing?.claude_state ?? null,
  })
  const cleaned = cleanNote(note)

  await writeUserNotice(sb, task.notice_id, existing, {
    ...patch,
    claude_note: patch.claude_state === null ? null : (cleaned ?? DEFAULT_NOTES[event]),
  })

  const now = new Date().toISOString()
  const events = Array.isArray(task.events) ? task.events.slice(-49) : []
  events.push({ event, note: cleaned, at: now })
  await sb.from("claude_tasks")
    .update({ last_event: event, last_event_at: now, events })
    .eq("token", token)

  return text(`OK – Doffin Monitor oppdatert for kunngjøring ${task.notice_id}. ${EVENT_CONFIRMATIONS[event]}`)
}

// ── Router ──────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    if (req.method === "GET") {
      const p = new URL(req.url).searchParams
      const token = p.get("t") || p.get("token")
      if (!token) return text(HELP, 400)
      return await handleEvent(sb, token, p.get("e") || p.get("event"), p.get("note"))
    }

    if (req.method === "POST") {
      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch {
        return text("FEIL: Forventet JSON-body.\n\n" + HELP, 400)
      }
      if (body.action === "create") {
        const { denied } = await authorize(req, sb, ["commit"], corsHeaders)
        if (denied) return denied
        return await createTask(sb, String(body.token ?? ""), String(body.notice_id ?? ""))
      }
      const token = String(body.token ?? body.t ?? "")
      if (!token) return text(HELP, 400)
      const event = body.event ?? body.e
      return await handleEvent(
        sb,
        token,
        event == null ? null : String(event),
        body.note == null ? null : String(body.note),
      )
    }

    return text("Method not allowed", 405)
  } catch (err) {
    console.error(err)
    return text("FEIL: " + (err as Error).message, 500)
  }
})

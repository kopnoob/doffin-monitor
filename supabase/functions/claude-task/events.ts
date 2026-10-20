// Ren logikk for Claude-statushendelser — ingen Deno/Supabase-avhengigheter,
// så den kan testes isolert.

export type ClaudeState = "queued" | "working" | "waiting" | "done" | null

export interface NoticeState {
  status: string | null
  sub_status: string | null
  claude_state: string | null
}

export interface Patch {
  status: string | null
  sub_status: string | null
  claude_state: ClaudeState
}

export const EVENT_NAMES = [
  "start",
  "jobber",
  "venter",
  "sendt",
  "paameldt",
  "blokkert",
  "avbryt",
] as const

export type EventName = typeof EVENT_NAMES[number]

export function isEventName(e: string): e is EventName {
  return (EVENT_NAMES as readonly string[]).includes(e)
}

// Det Claude får tilbake etter et vellykket kall.
export const EVENT_CONFIRMATIONS: Record<EventName, string> = {
  start: "Status satt til «Aktuell / Under arbeid». Dashboardet viser nå at Claude jobber med denne.",
  jobber: "Dashboardet viser at Claude jobber.",
  venter: "Dashboardet viser at Claude venter på brukeren.",
  sendt: "Substatus satt til «Tilbud sendt». Claude-oppgaven er markert som ferdig.",
  paameldt: "Status satt til «Påmeldt». Claude-oppgaven er markert som ferdig.",
  blokkert: "Substatus satt til «Blokkert». Claude-oppgaven er markert som ferdig.",
  avbryt: "Claude-oppgaven er avbrutt. Statusen kan nå styres manuelt igjen.",
}

// Standardnotat i dashboardet hvis Claude ikke sender eget notat.
export const DEFAULT_NOTES: Record<EventName, string> = {
  start: "Claude har startet",
  jobber: "Claude jobber",
  venter: "Venter på input fra deg",
  sendt: "Søknad sendt",
  paameldt: "Påmeldt / kvalifisert",
  blokkert: "Blokkert",
  avbryt: "Avbrutt",
}

/** Hvilken status/substatus/Claude-tilstand en hendelse fører til. */
export function applyEvent(event: EventName, cur: NoticeState): Patch {
  const enrolled = cur.status === "enrolled"
  // «Aktuell» med mindre den allerede er påmeldt — Claude skal aldri nedgradere.
  const activeStatus = enrolled ? "enrolled" : "relevant"

  switch (event) {
    case "start":
      return { status: activeStatus, sub_status: "under-arbeid", claude_state: "working" }

    case "jobber":
    case "venter": {
      // Tåler at «start» ble hoppet over.
      const missingStart = cur.status === null || cur.status === "dismissed"
      return {
        status: missingStart ? "relevant" : cur.status,
        sub_status: missingStart || !cur.sub_status || cur.sub_status === "vurdering"
          ? "under-arbeid"
          : cur.sub_status,
        claude_state: event === "jobber" ? "working" : "waiting",
      }
    }

    case "sendt":
      return { status: activeStatus, sub_status: "tilbud-sendt", claude_state: "done" }

    case "paameldt":
      return { status: "enrolled", sub_status: cur.sub_status, claude_state: "done" }

    case "blokkert":
      return { status: activeStatus, sub_status: "blokkert", claude_state: "done" }

    case "avbryt":
      return {
        status: cur.status,
        sub_status: cur.sub_status === "under-arbeid" ? "vurdering" : cur.sub_status,
        claude_state: null,
      }
  }
}

/** Fjerner kontrolltegn og kutter notater til en fornuftig lengde. */
export function cleanNote(note: string | null | undefined): string | null {
  if (!note) return null
  // deno-lint-ignore no-control-regex
  const s = note.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
  return s ? s.slice(0, 280) : null
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{24,64}$/
export const NOTICE_ID_RE = /^[A-Za-z0-9_.-]{1,100}$/

-- «Søk med Claude»: Claude (brukerens eget abonnement) oppdaterer status i
-- Doffin Monitor via edge-funksjonen claude-task, autentisert med en
-- engangsnøkkel per oppgave som ligger i prompten brukeren kopierer.

-- Claude-tilstand per kunngjøring, vist som spinner/chip i dashboardet.
--   queued  = prompt kopiert, Claude har ikke startet ennå
--   working = Claude jobber
--   waiting = Claude venter på input fra brukeren
--   done    = Claude er ferdig (sendt, påmeldt eller blokkert)
--   null    = ingen Claude-oppgave
alter table public.user_notices
  add column if not exists claude_state text,
  add column if not exists claude_note text,
  add column if not exists claude_updated_at timestamptz;

-- Én rad per kopierte prompt. Nøkkelen gir kun tilgang til å oppdatere
-- statusen for sin egen kunngjøring.
create table if not exists public.claude_tasks (
  token          text primary key,
  notice_id      text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '60 days',
  last_event     text,
  last_event_at  timestamptz,
  events         jsonb not null default '[]'::jsonb
);

create index if not exists claude_tasks_notice_id_idx on public.claude_tasks (notice_id);

-- Kun edge-funksjonen (service role) skal lese/skrive nøkler.
-- RLS uten policies stenger anon-nøkkelen ute.
alter table public.claude_tasks enable row level security;

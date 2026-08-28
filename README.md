# AUIB Section Monitor

An offline-first, read-only MVP foundation for monitoring Oracle PeopleSoft class-section state and eventually notifying subscribed Telegram users when that state changes.

The system is a **change detector**. It is designed to notice both status transitions (`CLOSED` to `OPEN`, for example) and verified numeric seat-count transitions. A missing seat count remains `null`; the code never turns an observed `Closed` label into an invented numeric zero.

## Current milestone

This repository currently implements Phases 1–3 only:

- Node.js 22, pnpm, strict TypeScript, ESLint, Prettier, and Vitest tooling
- validated environment configuration with live PeopleSoft mode off by default
- the `SectionState` domain model and pure change detector
- offline PeopleSoft hidden-state, course-action, Activity Guide, and class-selection parsers
- sanitized fixtures and parser/change-detection tests
- secret redaction and per-session serialization primitives
- local PostgreSQL Docker Compose infrastructure for the later persistence phase

There is intentionally no live PeopleSoft HTTP client, automated login, Microsoft authentication flow, MFA handling, Telegram bot process, database schema, scheduler, or enrollment functionality yet.

## Safety boundary

This project is read-only. It must never add, drop, enroll, submit registration, or mutate a student record. It must not bypass Microsoft authentication, MFA, CAPTCHA, Conditional Access, Cloudflare, Datawiza, or any other access control.

Live PeopleSoft mode defaults to disabled:

```dotenv
PEOPLESOFT_LIVE_ENABLED=false
```

Future live transports must call the explicit live-mode guard before making a request. Tests also install a guard that rejects attempts to fetch `sis.auib.edu.iq`. Phase 3 only reads local sanitized fixture files.

## Why the PeopleSoft workflow is stateful

The observed Campus Solutions Fluid UI does not establish a stateless class endpoint. A course row exposes a generated `ICAction`, such as `CRSE_DESCR1$32`, but the row suffix can change on the next render. Component posts carry fresh hidden state such as `ICStateNum` and `ICElementNum`, while the selected course can live in server-side session/component state.

Likewise, Activity Guide list/item identifiers and PeopleSoft window/node identifiers are transient. The parsers therefore discover current actions, hidden fields, service identifiers, and target URLs from each response. No captured row number, Activity Guide ID, `ICSID`, `ps_13`, or `win13` value is treated as a permanent identifier.

## Project layout

```text
src/
  config/                  environment parsing and safe defaults
  domain/                  normalized section state and changes
  fixtures/peopleSoft/     synthetic, sanitized response examples
  peoplesoft/
    parsers/               pure offline response parsers
    session.ts             isolated serialized session primitive
    live-mode.ts           mandatory future live-request gate
  security/                structured secret redaction
tests/                     Vitest tests; no live SIS traffic
research/
  README.md                capture-handling and sanitization rules
  sanitized/               safe research artifacts only
```

Persistence, Telegram, monitoring, HTTP workflow, and encryption modules will be added in their later approved phases rather than represented as working code now.

## Local setup

Requirements:

- Node.js 22 or newer
- pnpm 11
- Docker with Compose, only if you want to start the future local database

Install and verify:

```powershell
pnpm install
pnpm check
```

Individual commands:

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Start local PostgreSQL:

```powershell
docker compose up -d postgres
```

The database container is preparatory in this milestone; Phase 4 will add the Drizzle schema and migrations.

## Offline fixtures

The examples under `src/fixtures/peopleSoft/` are synthetic HTML/XML shaped around the explicitly documented fields. Tests load them from disk and verify that parsers:

- resolve a course's current `ICAction` without hard-coding its row suffix
- copy current hidden component state
- find the `SSR_ENRL_SELECT_FL` Activity Guide information dynamically
- return every section row rather than assuming a single class
- normalize known status labels
- keep `availableSeats` as `null` when no verified number is present
- parse a number only when the fixture explicitly labels it as available seats

`FixtureSectionChecker` composes four snapshots—the course page, Activity Guide step, preprocessing target, and class-selection result—inside a serialized fixture session. It validates that the dynamic prerequisites are present, but it does **not** replay form posts, HTTP redirects, cookies, or server-side component-state transitions.

The exact AIPreProcessing envelope and section-row containment markup are still synthetic because no sanitized raw responses were supplied with this repository. Those fixture shapes must be replaced or extended when authorized sanitized captures become available; the known component/field names come only from the supplied brief.

## Planned Telegram commands

The Phase 5 bot contract is reserved as follows; these commands are not implemented yet:

- `/start` — explain the read-only monitor
- `/watch 1494` — enable a subscription and establish a no-alert baseline when needed
- `/unwatch 1494` — disable that subscription
- `/watches` — list enabled subscriptions
- `/status 1494` — show the latest real observation, never fabricated availability

## Handling captures and sessions

HAR files and authenticated browser/session data can contain `PS_TOKEN`, `JSESSIONID`, `ICSID`, Cloudflare/Datawiza tokens, cookies, operator identifiers, and student identifiers. They must never be committed, logged, copied into snapshots, or placed in documentation.

The repository ignores `*.har`, `research/private/`, local environment files, browser storage state, cookie jars, and `storage/sessions/`. Only sanitized synthetic fixtures belong in version control. See `research/README.md` before adding a new fixture.

Passwords will never be stored. A later manually authorized-session milestone will keep authentication separate from monitoring and encrypt session material with authenticated encryption using `SESSION_ENCRYPTION_KEY`.

## Next milestone

After the offline parsers are checked against additional user-supplied sanitized captures, the recommended next phase is Phase 4 persistence: Drizzle/PostgreSQL tables and repositories for users, sections, state history, subscriptions, encrypted session records, and idempotent notification fingerprints. Live PeopleSoft integration remains separately gated and requires explicit approval.

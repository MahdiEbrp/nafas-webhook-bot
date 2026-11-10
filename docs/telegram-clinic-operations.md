# Telegram clinic workflows: route coverage and boundaries

This note records the conversational API scope reviewed against
`MahdiEbrp/beauty-clinic` at the inspected tree SHA
`af5d4f872a7ac8f75fa1e6780e788e83557c5100`. The Telegram allow-list and request
validation live in `lib/clinic-operations/api.ts`; the guided conversational
workflows live in `lib/telegram/clinic-operations.ts`.

## Exposed routes

All paths below are under `/api/v1`. `:id` is a UUID validated locally before
it is placed in a path. For a chat request, supported methods are exact entries
in the `specs` table—there is no arbitrary path or URL operation.

| Resource / workflow | Route and methods | Upstream access rule |
| --- | --- | --- |
| Service-group catalog | `/service-groups` GET, POST; `/service-groups/:id` GET, PATCH, DELETE; `/service-groups/bulk` POST | Authenticated; upstream service permissions apply to writes and item reads. The root GET has no extra permission declaration. |
| Service categories | `/service-categories` GET, POST; `/service-categories/:id` GET, PATCH, DELETE; `/service-categories/bulk` POST | Authenticated; `services.read`, `services.write`, or `services.manage` as declared by the upstream route. |
| Services and catalog | `/services` GET, POST; `/services/:id` GET, PATCH, DELETE; `/services/bulk` POST; `/services/catalog` GET | Authenticated; `services.read`, `services.write`, or `services.manage`. |
| Care guides | `/care-guides` GET, POST; `/care-guides/:id` GET, PATCH, DELETE; `/care-guides/bulk` POST | Authenticated; `care-guides.read`, `care-guides.write`, or `care-guides.manage`. |
| Care-guide items | `/care-guide-items` GET, POST; `/care-guide-items/:id` GET, PATCH, DELETE; `/care-guide-items/bulk` POST | Authenticated; `care-guides.read`, `care-guides.write`, or `care-guides.manage`. |
| Landing marquee, service cards, statistics, gallery | For each collection: `GET/POST` on `/landing/{marquee,services,stats,gallery}`, `GET/PATCH/DELETE` on `/landing/{collection}/:id`, and `POST` on `/landing/{collection}/bulk` | Authenticated; `services.read`, `services.write`, or `services.manage`. Gallery creation edits metadata only; it does not transfer a file. |
| Landing hero and sections/SEO | `/landing/hero` GET, PATCH; `/landing/sections` GET, PATCH | Authenticated; reads require `services.read`, writes require `services.write`. |
| Admin bookings | `/bookings` GET, POST; `/bookings/:id` GET, PATCH, DELETE; `/bookings/bulk` POST | Authenticated; `appointments.read`, `appointments.write`, or `appointments.manage` as declared upstream. |
| Slot availability and admin slots | `/bookings/slots` GET, POST; `/bookings/slots/list` GET; `/bookings/slots/:id` GET, PATCH, DELETE; `/bookings/slots/bulk` POST; `/bookings/slots/generate` POST | Authenticated; `appointments.read`, `appointments.write`, or `appointments.manage`. Slot generation requires the upstream manage permission and explicit confirmation. |
| Customer's own bookings | `/me/bookings` GET; `/me/bookings/:id/cancel` POST | Authenticated and scoped by the upstream to the signed-in owner; cancellation is confirmed and rechecked for `canCancel` immediately before execution. |
| Notifications | `/notifications` GET; `/notifications/read` PATCH | Authenticated. The read-state mutation is confirmed. |
| Profile and account security | `/auth/me` GET; `/auth/password` POST; `/auth/sessions` DELETE; `/auth/logout` POST | The profile, password, and session routes require authentication. Logout is called only from an existing bot session; the local stored session is cleared after password change or logout. Password messages are handled locally and never sent to the intent model. |

The allow-list contains 81 route/method entries. `scripts/clinic-operations-test.ts`
uses HTTP mocks to exercise every entry and verifies the HTTP method, path,
validated payload, session cookie, origin, CSRF token, no-store policy, and
redirect rejection. It also verifies invalid and excluded paths never reach the
mock upstream.

## Existing Telegram workflows retained

The general clinic-operation API does not duplicate the existing workflows for
OTP sign-in, rules, users, working hours, social links, settings, SMS, email, or
payments. Those remain in their existing Telegram handlers and keep their own
schemas and confirmations; in particular, the prior email-admin work is not
replaced by this route allow-list.

## Security and conversation behavior

- Clinic operations are dispatched only by the Telegram handler and require a
  private chat plus the authenticated session belonging to that Telegram user.
  No clinic-operation endpoint or dispatch was added to `/api/chat`.
- Requests use a fixed HTTPS origin, the bot's stored session cookie, the
  upstream CSRF token, `Origin`, `credentials: omit`, `redirect: error`, and
  `cache: no-store`. No HTTP mutation is retried automatically.
- The local Zod contracts mirror the upstream validators at the reviewed
  revision. The upstream remains authoritative for authentication, permissions,
  ownership, transactional booking availability, and business rules; a denied
  operation remains a denial (for example, a sanitized `FORBIDDEN` result).
- Mutations and bookings show a preview and require an explicit, single-use
  confirmation. Updates/deletes compare a fresh read with the preview snapshot;
  customer cancellation rechecks owner-scoped cancellation eligibility. Booking
  names, phone numbers, emails, and passwords stay in deterministic local
  steps, are excluded from planner inputs, and are marked for best-effort
  Telegram message deletion. Booking preview phone/email values are masked.
- Planner input contains only bounded request text, safe row summaries, and
  non-sensitive query metadata. Search values remain local for the HTTP call;
  phone/email-shaped text is scrubbed without rewriting ISO dates. Responses are
  bounded to 2 MiB while reading, then shape/depth/array/string limits are
  applied before they can enter a reply.
- Pending state is process-local, actor/session-bound, capped and expires after
  five minutes. It is intentionally lost on a restart or cold start.

## Deliberate exclusions

The reviewed upstream tree has 130 route files; this Telegram allow-list does
not expose the following:

- `/api/v1/webhooks/**` — webhook credentials/contract and event-oriented
  endpoints are not conversational operations.
- `/api/v1/payments/callback` and other callback/notification handlers — these
  are provider-driven, not user commands.
- `/api/v1/files/**` — upload, download, copy, move/rename, trash, and file
  content transfer are excluded. A gallery `imageUrl` is metadata only.
- `/api/v1/internal/**` — internal jobs are not user-invocable.
- `/api/v1/notifications/stream` — server-sent event stream is not proxied.
- `/api/v1/auth/register` and public booking/payment APIs — these are
  unauthenticated onboarding/checkout surfaces, not operations using the
  user's existing authenticated bot session. Registration creates a new
  account and session and does not establish OTP-verified phone ownership at
  enrollment; adding it would require a separate identity-verification,
  consent, and session-bootstrap design. No registration route is exposed here.
- Other route families are either outside the chat workflow scope or already
  covered by the separate Telegram modules listed above. The allow-list does
  not expose users, rules, working-hours, social-links, settings, email, SMS,
  payment administration, or generic API paths through this manager.

Run `npm run clinic:test` for the route/workflow HTTP mocks. `npm run check`
includes these tests alongside the project's self-test.

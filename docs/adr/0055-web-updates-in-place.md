# 0055 — The web app updates in place; one tap for a single choice

**Status:** Accepted (decided 2026-11-19; built in P2.7b)

**Context.** The web app's forms post to a BFF action
(`apps/web/src/app/actions/[action]/route.ts`), which calls the API and
redirects; the browser then loads the whole page again. That made every
form work without client JavaScript, but every change, however small,
reloads the page: the scroll position jumps, open sections close, focus is
lost, and a list of answers needs one reload per row. Answering an
activity on its page also needs two steps (pick "Kommer", then "Spara
svaret"), while the mobile app answers with one tap. About 190 actions on
90 pages and components work this way.

**Decision.**

1. **Change in place.** When an action changes something on the page the
   user is on (an answer, a mark, a setting, a toggle, a row added to or
   removed from a list, a status), only that part of the page changes: no
   full reload, the scroll position, focus and open sections are kept, and
   the result (the new state, or an error next to the control) is
   announced to screen readers (`aria-live`).
2. **Navigate only to go somewhere else.** A full page change is right
   when the action leads to another resource: creating something opens it,
   deleting the resource the page shows goes back to its list, logging in
   or out, leaving a club. Then the browser loads that page (so the whole
   frame, the bell's count included, is current there).
3. **One tap for a single choice.** Where the user picks one of a few
   values (coming / not coming, present / absent, a yes/no setting, a
   status), the tap saves it. Free text that goes with it (a note to the
   leaders) is optional and saved on its own (its own button, or when the
   field loses focus), never needed to save the choice. Web and mobile
   behave the same.
4. **Optimistic where it is safe.** A single choice shows its new value at
   once and is rolled back with an inline error if the API refuses it
   (as the mobile app does). Actions with consequences (money, deletion,
   locking, erasure, permissions) wait for the API and keep their
   confirmation step.
5. **Progressive enhancement stays.** Forms keep posting to the same BFF
   actions and still work without JavaScript (and for the end-to-end tests
   that need it). With JavaScript, one shared client component (an
   enhanced `ActionForm`) submits with `fetch` (CSRF token as today, the
   action answering JSON when asked), then fetches the current route's
   server components again (`router.replace` without scrolling and
   `router.refresh()`, the frame included) or loads the other page, so
   pages need no per-action client code. It is loaded on demand
   and counted in the initial JavaScript budget (ADR 0027).
6. **Unsaved changes ask first** (P2.7b). A form where several fields are
   typed (an event, an activity, a series, an announcement, a duty shift,
   a role) opts in with `ActionForm guard` (`GuardedForm` for a plain GET
   form): leaving it with changes gets the browser's prompt on unload and
   an in-app dialog for links inside the app. A new event also keeps what
   was typed as a draft (`ActionForm draft`): in the browser's
   `localStorage`, per person and form, never on the server, offered again
   ("Fortsätt på utkastet" / "Börja om") and removed when the form is
   sent. Server-side drafts (`status = 'draft'`, the same draft on every
   device) would need a migration, history and audit; they are left until
   users ask for them.
7. **Rules for new code.** A new form uses the shared component; its kind
   follows from where the action's `done()` leads: back to the same page is
   in place, another page navigates (rule 2). A review
   rejects a form that reloads the page for a change on the same page, and
   a single choice that needs a separate "Save".

**Consequences.** One client component and a JSON answer from the BFF
action route; Playwright tests check that the page did not reload (a marker
in `window` survives) and that focus stays. Error codes keep coming from
the API's problem details and are shown next to the control. Pages that
render state from query parameters (`?saved=1`, `?error=`) keep doing so
for both paths; with JavaScript the query changes without a reload.

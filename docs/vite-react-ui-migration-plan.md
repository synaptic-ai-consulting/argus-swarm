---
name: Vite React UI Migration
overview: Migrate the Argus dashboard from a single HTML file with vanilla JS to a Vite + React (TypeScript) app, preserve the current feature set for validation, then use this stack for the ASO control hub enhancements.
todos: []
isProject: false
---

# Migrate UI to Vite + React, Then Implement Enhancements

## Scope

**Phase 1 (this plan):** Migrate the existing dashboard to Vite + React with **feature parity** (same behavior, same API usage). No new features; no removal of Trust Distribution yet.

**Phase 2 (after validation):** Implement the ASO control hub changes (Intent Delegation, Swarm & Exception Review tab, job model, pipeline diagram, etc.) on the new React stack.

---

## Current UI surface to replicate

- **API usage:** `GET /api/agents`, `GET /api/exceptions?all=1`, `GET /api/metrics`; `POST /api/review/approve|reject/:id` with `Accept: application/json`; `POST /api/review/followup/:id` with `{ message }`.
- **Behavior:** Poll every 5s; header pills (Running, Done, Error, Exceptions); metrics strip (8 tiles); left panel (swarm status rows, agent grid, Trust Distribution); right panel (exception queue with approve/reject/follow-up, resolved toggle); activity feed; agent popover on dot click; escape for XSS in user content.
- **Styling:** Dark theme, CSS variables and layout from [src/ui/dashboard.html](src/ui/dashboard.html) (lines 7–570).

---

## 1. Add Vite + React app

- **Location:** New directory `ui/` at repo root (sibling to `src/`).
- **Scaffold:** `npm create vite@latest ui -- --template react-ts` (or equivalent) so that `ui/` contains a Vite + React + TypeScript app with `index.html` at root, `src/main.tsx`, `src/App.tsx`, and `src/index.css`.
- **Dependencies:** No extra UI libs required for parity; use React state and `fetch` only.
- **Vite config** ([ui/vite.config.ts](ui/vite.config.ts)):
  - **Dev proxy:** Proxy `/api` to `http://localhost:3848` (or env `VITE_API_ORIGIN`) so `fetch("/api/...")` works when running Vite dev server.
  - **Build output:** `outDir: "../dist/ui/app"` so the built SPA lives at `dist/ui/app/` (index.html + assets/), alongside the existing Node server at `dist/ui/server.js`, without overwriting it.
  - **Base:** `base: "/"` so asset paths are absolute and the Node server can serve the app under `/`.

---

## 2. Recreate dashboard in React

- **State:** One place (e.g. `App` or a small context) holding `agents`, `exceptions`, `metrics` (and optionally `resolvedVisible`). Same shapes as current API responses (no API change).
- **Data loading:** Single `useEffect` that calls the three GET endpoints, then `setInterval` (5s) to repeat. No new endpoints.
- **Components (mirror current layout):**
  - **Header:** Logo + status pills (Running, Done, Error, Exceptions count).
  - **MetricsStrip:** 8 metric tiles (same labels, same N/A for last three).
  - **SwarmPanel:** Status rows + agent grid (dots by status, trust border) + Trust Distribution bars. Click on dot opens popover.
  - **ExceptionPanel:** Pending exception cards (decision badge, confidence, checks, meta, Approve/Reject/Follow-up); resolved section with toggle; follow-up inline input + Send.
  - **ActivityFeed:** Reverse-chronological events (exceptions + resolved + FINISHED agents), same logic as current `renderFeed`.
  - **AgentPopover:** Shown on dot click; content = name, status, ID, branch, PR link, trust, elapsed, intent, summary; overlay click to close; position near clicked dot.
- **Styling:** Move the existing dashboard CSS (variables, layout, component classes) into `ui/src/index.css` (or `App.css`) so the look matches. Reuse the same class names and structure where practical.
- **XSS:** Render user/content strings safely (e.g. no `dangerouslySetInnerHTML` for agent names, branch, summary; use text or a small escape helper as in current `esc()`).

---

## 3. Serve the SPA from the Node UI server

- **File:** [src/ui/server.ts](src/ui/server.ts).
- **Behavior:** Keep all existing `/api/`* routes unchanged. For non-API requests:
  - `GET /` or `GET /index.html` → serve `index.html` from `join(__dirname, "app", "index.html")` (with `Content-Type: text/html`). So the built app must end up at `dist/ui/app/`.
  - `GET /assets/`* → serve the file from `join(__dirname, "app", url.pathname)` (e.g. `dist/ui/app/assets/...`). Set `Content-Type` from extension (e.g. `.js` → `application/javascript`, `.css` → `text/css`) so the browser loads assets correctly.
- **Fallback:** If path is not `/`, `/index.html`, `/api/`*, or `/assets/`*, respond with 404 (or optionally serve `index.html` for SPA client-side routing later).
- **Remove:** No more reading or serving `dashboard.html`; remove `DASHBOARD_HTML` and the old `/` branch that served it.

---

## 4. Build and scripts

- **Root [package.json](package.json):**
  - Remove the `cp src/ui/dashboard.html dist/ui/dashboard.html` step.
  - Build: run backend compile then UI build, e.g. `"build": "tsc && cd ui && npm run build"`. Ensure `ui`’s Vite `outDir` is `../dist/ui/app` so `dist/ui/app` exists after build.
- **Dev workflow:** Document that for UI development you can run the API server (`argus ui` or `argus run`) on 3848 and `cd ui && npm run dev` (Vite on 5173) with proxy to 3848; for production, `npm run build` then `argus ui` serves the SPA from the same port.

---

## 5. Validation (current feature set)

After migration, verify without changing APIs or behavior:

- **Load:** Open `http://localhost:3848` (or Vite dev with proxy); page loads without errors.
- **Header:** Pills show correct counts (Running, Done, Error, Exceptions).
- **Metrics:** All 8 tiles render; the 5 computed values and 3 N/A match previous behavior.
- **Swarm:** Status rows and agent dots render; trust borders correct; Trust Distribution bars present.
- **Exceptions:** Pending cards show; Approve and Reject update list and counts; Follow-up expands input, Send calls followup API and refreshes.
- **Activity feed:** Events in reverse order; content matches current logic.
- **Popover:** Click agent dot opens popover with correct details; overlay click closes.
- **Refresh:** Data refreshes every 5 seconds.

No new endpoints; no change to API contracts or server logic beyond how the HTML and static files are served.

---

## 6. Phase 2 (after this migration)

Once Phase 1 is tested and merged, implement the ASO control hub enhancement plan on the React app: job model and APIs (backend), sidebar nav (Intent Delegation vs Swarm & Exception Review with swarm icon), job list and create form, pipeline diagram, job-scoped metrics/grid/exceptions/feed, agent grid spinner for running, remove Trust Distribution, etc. That work is out of scope for this migration plan.

---

## 7. File and directory summary


| Item                      | Action                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **ui/**                   | New: Vite + React + TS app (index.html, src/main.tsx, App.tsx, components, index.css, vite.config.ts, package.json).           |
| **ui/vite.config.ts**     | Proxy `/api` to API server; `outDir: "../dist/ui/app"`, `base: "/"`.                                                           |
| **src/ui/server.ts**      | Serve `dist/ui/app/index.html` for `/` and `/index.html`; serve `dist/ui/app/assets/`* for `/assets/`*; remove dashboard.html. |
| **package.json** (root)   | Build script: `tsc && cd ui && npm run build`; remove `cp ... dashboard.html`.                                                 |
| **src/ui/dashboard.html** | Keep in repo during migration for reference; can be removed or archived once React UI is validated.                            |


---

## 8. Implementation order

1. Scaffold `ui/` with Vite + React + TypeScript; configure Vite (proxy, outDir, base).
2. Port CSS from dashboard.html into `ui/src/index.css`.
3. Implement data fetching (agents, exceptions, metrics) and 5s refresh in App (or a hook).
4. Implement Header, MetricsStrip, SwarmPanel (with Trust Distribution), ExceptionPanel, ActivityFeed, AgentPopover.
5. Update server.ts to serve SPA (index.html + /assets/*) instead of dashboard.html.
6. Update root package.json build script; ensure `npm run build` produces `dist/ui/app/`.
7. Manual test of all features; fix any regressions.
8. Optionally remove or archive `src/ui/dashboard.html` after validation.


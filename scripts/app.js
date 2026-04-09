/**
 * HireMatchAI — RBAC in UI; users, audit trail, and recruiter data from the API.
 */

const SESSION_KEY = "hirematchai_session_v1";
const API_BASE_URL =
  typeof window.__API_BASE__ === "string" && window.__API_BASE__
    ? window.__API_BASE__
    : "http://localhost:5113";

/** Normalized rows for the audit log table (from GET /api/audit-logs). */
let auditLogRows = [];

let auditFilter = "all";
let appListenersAttached = false;
let rankedTalentLoaded = false;
let reviewRequestsLoaded = false;
let jobsLoaded = false;
let profileLoaded = false;
let seekerDecisionsLoaded = false;
let recruiterDecisionsLoaded = false;
let transparencyLoaded = false;
let decisionsRankPreviewLoaded = false;
let explainabilityRecruiterLoaded = false;

/** Latest GET /api/recruiter/decision-snapshot rows for client-side algorithm filter. */
let recruiterDecisionsRows = [];

const ROLE_BANNER = {
  seeker:
    "Signed in as Seeker: Job postings (ranked for you), Profile, and Explainability. No directory, fairness console, about page, or audit log.",
  recruiter:
    "Signed in as Recruiter: Ranked talent (AI), reviewer workstation (claim, address, resolve with final action including escalate to admin). No directory or About. Audit log: Auditor/Admin only.",
  auditor:
    "Signed in as Auditor: Directory, Audit log, Fairness, About. Applicant review queue is recruiter-only; ranked talent is recruiter-only.",
  admin:
    "Signed in as Admin: Ranked talent, Review requests, Directory, Audit log, About, and exports.",
};

const TAB_LABELS = {
  "tab-dashboard": "Dashboard",
  "tab-jobs": "Job postings",
  "tab-profile": "Profile",
  "tab-ranked": "Ranked talent",
  "tab-review-requests": "Review requests",
  "tab-directory": "Directory",
  "tab-decisions": "Decisions",
  "tab-audit": "Audit log",
  "tab-fairness": "Fairness",
  "tab-transparency": "Explainability",
  "tab-reference": "About",
};

function el(id) {
  return document.getElementById(id);
}

async function fetchData(path, options = {}) {
  const requestUrl = `${API_BASE_URL}${path}`;
  const response = await fetch(requestUrl, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with status ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function showApiMessage(containerId, message) {
  const node = el(containerId);
  if (!node) return;
  if (!message) {
    node.textContent = "";
    node.classList.add("d-none");
    return;
  }
  node.textContent = message;
  node.classList.remove("d-none");
}

function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.email !== "string" || typeof parsed.role !== "string") {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return {
      email: parsed.email.trim().toLowerCase(),
      name: typeof parsed.name === "string" ? parsed.name : parsed.email,
      role: parsed.role,
    };
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function saveSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

function showLoginView() {
  delete document.body.dataset.appRole;
  const loginView = el("loginView");
  const appView = el("appView");
  if (loginView) {
    loginView.classList.remove("d-none");
    loginView.setAttribute("aria-hidden", "false");
  }
  if (appView) {
    appView.classList.add("d-none");
    appView.setAttribute("aria-hidden", "true");
  }
}

function showAppView() {
  const loginView = el("loginView");
  const appView = el("appView");
  const active = document.activeElement;
  if (loginView && active && loginView.contains(active) && typeof active.blur === "function") {
    active.blur();
  }
  if (loginView) {
    loginView.classList.add("d-none");
    loginView.setAttribute("aria-hidden", "true");
  }
  if (appView) {
    appView.classList.remove("d-none");
    appView.setAttribute("aria-hidden", "false");
  }
}

function formatRoleTitle(role) {
  const r = String(role || "").toLowerCase();
  if (r === "seeker") return "Applicant";
  if (r === "recruiter") return "Recruiter";
  if (r === "auditor") return "Auditor";
  if (r === "admin") return "Admin";
  return role || "User";
}

function updateSessionDisplay(session) {
  const badge = el("navbarLoggedInBadge");
  if (!badge || !session) return;
  const dept = (session.department || "").trim();
  const jt = (session.jobTitle || "").trim();
  const workstation = jt || dept || formatRoleTitle(session.role);
  badge.textContent = `Logged in as: ${session.name} | ${workstation}`;
}

function formatType(t) {
  const map = {
    job_match: "Job match",
    candidate_rank: "Candidate rank",
    audit_view: "Access / view",
    human_review: "Human review",
  };
  return map[t] || t;
}

function inferAuditType(summary) {
  const s = String(summary || "").toLowerCase();
  if (s.includes("resolved as") || s.includes("started review") || s.includes("reviewer "))
    return "human_review";
  if (s.includes("view") || s.includes("export") || s.includes("open_audit"))
    return "audit_view";
  if (s.includes("rank") || s.includes("pool")) return "candidate_rank";
  return "job_match";
}

function mapApiAuditRow(row) {
  const summary = row.complianceStatus || "—";
  const iso =
    row.auditTimestamp != null
      ? String(row.auditTimestamp).replace("T", " ").slice(0, 19)
      : "—";
  const type = inferAuditType(summary);
  const policyParts = [];
  if (row.reviewerId != null) policyParts.push(`reviewer ${row.reviewerId}`);
  if (row.factorId != null) policyParts.push(`factor ${row.factorId}`);
  if (row.userId != null) policyParts.push(`user ${row.userId}`);
  const policy = policyParts.length ? policyParts.join(" · ") : "—";
  const outcome =
    row.impactRatio != null && row.impactRatio !== undefined ? String(row.impactRatio) : "—";
  return { time: iso, type, subject: summary, policy, outcome };
}

async function loadAuditLogs() {
  try {
    const raw = await fetchData("/api/audit-logs");
    auditLogRows = Array.isArray(raw) ? raw.map(mapApiAuditRow) : [];
  } catch (e) {
    console.error("audit logs:", e);
    auditLogRows = [];
  }
  renderAuditTable();
}

async function appendClientAudit(summary) {
  const s = String(summary).trim().slice(0, 200);
  if (!s) return;
  try {
    await fetchData("/api/audit-logs/append", {
      method: "POST",
      body: JSON.stringify({ summary: s, userId: null, reviewerId: null, factorId: null }),
    });
    await loadAuditLogs();
  } catch (e) {
    console.error("append audit:", e);
  }
}

function mapUiRoleFromDb(userRole) {
  const x = String(userRole || "").toLowerCase();
  if (x.includes("audit")) return "auditor";
  if (x === "admin") return "admin";
  if (x.includes("recruit") || x.includes("manager")) return "recruiter";
  return "seeker";
}

function directoryRoleBadgeClass(uiRole) {
  if (uiRole === "seeker") return "text-bg-primary";
  if (uiRole === "recruiter") return "text-bg-info text-dark";
  if (uiRole === "auditor") return "text-bg-dark";
  return "text-bg-secondary";
}

async function loadDirectoryFromApi() {
  const body = el("directoryTableBody");
  const hint = el("directoryHeaderHint");
  if (!body) return;
  try {
    const users = await fetchData("/api/users");
    body.replaceChildren();
    if (hint) {
      hint.textContent = `${Array.isArray(users) ? users.length : 0} users (from API)`;
    }
    if (!Array.isArray(users) || !users.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td colspan="5" class="text-secondary small">No users returned.</td>';
      body.appendChild(tr);
      return;
    }
    for (const u of [...users].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      const uiRole = mapUiRoleFromDb(u.userRole);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(u.name || "")}</td>
        <td><span class="badge ${directoryRoleBadgeClass(uiRole)}">${escapeHtml(uiRole)}</span></td>
        <td>—</td>
        <td>${escapeHtml(u.email || "")}</td>
        <td class="text-secondary small">—</td>
      `;
      body.appendChild(tr);
    }
  } catch (e) {
    console.error("directory:", e);
    body.replaceChildren();
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="5" class="text-secondary small">Could not load directory.</td>';
    body.appendChild(tr);
  }
}

function formatUtcShort(value) {
  if (value == null) return "—";
  const s = String(value).replace("T", " ").slice(0, 16);
  return s || "—";
}

function setMetricText(id, val) {
  const n = el(id);
  if (!n) return;
  n.textContent = val != null && val !== "" ? String(val) : "—";
}

async function loadDashboardMetrics(email) {
  const q = email ? `?email=${encodeURIComponent(email)}` : "";
  try {
    const m = await fetchData(`/api/dashboard/metrics${q}`);
    const s = m.seeker;
    setMetricText("metricSeekerApps", s?.transparencyRequests);
    setMetricText("metricSeekerSaved", m.scoringCriteriaCount);
    setMetricText("metricSeekerStrength", s?.linkedFactors);
    setMetricText("metricSeekerAi", s?.avgImpact != null ? String(s.avgImpact) : null);

    setMetricText("metricRecOpenReq", m.scoringCriteriaCount);
    setMetricText("metricRecCandidates", m.seekerRoleCount);
    setMetricText("metricRecMedian", "—");
    setMetricText("metricRecRuns", m.auditLogs7d);

    setMetricText("metricAudAudit", m.auditLogs24h);
    setMetricText("metricAudFlags", m.pendingTransparency);
    setMetricText("metricAudImpact", "—");
    setMetricText("metricAudDrift", "—");

    const ul = el("dashEscalationsList");
    if (ul && Array.isArray(m.recentAuditSummaries)) {
      ul.replaceChildren();
      if (!m.recentAuditSummaries.length) {
        const li = document.createElement("li");
        li.className = "list-group-item small text-secondary";
        li.textContent = "No audit log entries yet.";
        ul.appendChild(li);
      } else {
        for (const row of m.recentAuditSummaries) {
          const li = document.createElement("li");
          li.className = "list-group-item d-flex justify-content-between gap-2";
          const t = formatUtcShort(row.time);
          li.innerHTML = `<span class="text-break">${escapeHtml(row.summary || "—")}</span><span class="text-secondary text-nowrap">${escapeHtml(t)}</span>`;
          ul.appendChild(li);
        }
      }
    }
  } catch (e) {
    console.error("dashboard metrics:", e);
  }
}

async function loadJobMatches(email) {
  const body = el("jobMatchesTableBody");
  if (!body) return;
  try {
    const rows = await fetchData(`/api/seeker/job-matches?email=${encodeURIComponent(email)}`);
    body.replaceChildren();
    if (!Array.isArray(rows) || !rows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td colspan="8" class="text-secondary small">No open roles match your profile yet.</td>';
      body.appendChild(tr);
      jobsLoaded = true;
      return;
    }
    for (const row of rows) {
      const match = row.matchScore != null ? Number(row.matchScore) : null;
      const badge =
        match != null
          ? `<span class="badge ${scoreBadgeClass(match)}">${match.toFixed(2)}</span>`
          : "—";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(String(row.rank))}</td>
        <td>${escapeHtml(row.jobTitle || "—")}</td>
        <td>—</td>
        <td>—</td>
        <td class="text-end">—</td>
        <td class="text-end">${badge}</td>
        <td class="small">${escapeHtml(row.requiredSkills || "")}</td>
        <td><code class="small">${escapeHtml(`criteria-${row.criteriaId}`)}</code></td>
      `;
      body.appendChild(tr);
    }
    jobsLoaded = true;
  } catch (e) {
    console.error("job matches:", e);
    body.replaceChildren();
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="8" class="text-secondary small">Could not load job criteria from the API.</td>';
    body.appendChild(tr);
  }
}

async function loadProfileFromApi(email) {
  try {
    const p = await fetchData(`/api/profile?email=${encodeURIComponent(email)}`);
    const nameEl = el("profileDisplayName");
    const metaEl = el("profileDisplayMeta");
    const cardEmail = el("profileDisplayEmail");
    if (nameEl) nameEl.textContent = p.name || "—";
    if (metaEl) {
      metaEl.textContent = `${mapUiRoleFromDb(p.userRole)} · user_id ${p.userId}`;
    }
    if (cardEmail) cardEmail.textContent = p.email || "—";
    profileLoaded = true;
  } catch (e) {
    console.error("profile:", e);
  }
}

async function loadSeekerDecisions(email) {
  const body = el("seekerDecisionsTableBody");
  if (!body) return;
  const meta = el("seekerDecisionsHeaderMeta");
  try {
    const p = await fetchData(`/api/profile?email=${encodeURIComponent(email)}`);
    if (meta) meta.textContent = `user_id ${p.userId} · from user_decision_factors`;
  } catch {
    if (meta) meta.textContent = "—";
  }
  try {
    const rows = await fetchData(`/api/user/decision-history?email=${encodeURIComponent(email)}`);
    body.replaceChildren();
    if (!Array.isArray(rows) || !rows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        '<td colspan="5" class="text-secondary small">No decision factors linked to your account.</td>';
      body.appendChild(tr);
      seekerDecisionsLoaded = true;
      return;
    }
    for (const r of rows) {
      const sc = r.score != null ? String(r.score) : "—";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><code>${escapeHtml(r.decisionId)}</code></td>
        <td>${escapeHtml(r.type)}</td>
        <td>${escapeHtml(r.subject)}</td>
        <td>${escapeHtml(sc)}</td>
        <td>${escapeHtml(r.policy)}</td>
      `;
      body.appendChild(tr);
    }
    seekerDecisionsLoaded = true;
  } catch (e) {
    console.error("decision history:", e);
    body.replaceChildren();
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="5" class="text-secondary small">Could not load decisions.</td>';
    body.appendChild(tr);
  }
}

function populateDecisionsAlgoFilter(rows) {
  const sel = el("decisionsAlgoFilter");
  if (!sel) return;
  const models = [...new Set((rows || []).map((r) => String(r.modelName || "").trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b)
  );
  const cur = sel.value;
  sel.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All algorithms";
  sel.appendChild(all);
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  }
  if (models.includes(cur)) sel.value = cur;
}

function renderRecruiterDecisionsTable() {
  const body = el("recruiterDecisionsTableBody");
  const meta = el("recruiterDecisionsHeaderMeta");
  if (!body) return;
  const sel = el("decisionsAlgoFilter");
  const filterAlgo = sel && sel.value ? sel.value : "";
  const rows = filterAlgo
    ? recruiterDecisionsRows.filter((r) => String(r.modelName || "") === filterAlgo)
    : recruiterDecisionsRows;

  body.replaceChildren();
  if (meta) {
    meta.textContent =
      filterAlgo && rows.length === 0
        ? "No rows for this filter"
        : `${rows.length} row(s) · snapshot (max 40)`;
  }

  if (!recruiterDecisionsRows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td colspan="5" class="text-secondary small">No user_decision_factors rows in the database.</td>';
    body.appendChild(tr);
    return;
  }
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="5" class="text-secondary small">No rows match this algorithm filter.</td>';
    body.appendChild(tr);
    return;
  }
  for (const r of rows) {
    const sc = r.score != null ? String(r.score) : "—";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><code>${escapeHtml(r.decisionId)}</code></td>
      <td>${escapeHtml(r.type)}</td>
      <td>${escapeHtml(r.subject)}</td>
      <td>${escapeHtml(sc)}</td>
      <td>${escapeHtml(r.policy)}</td>
    `;
    body.appendChild(tr);
  }
}

async function loadRecruiterDecisions() {
  const body = el("recruiterDecisionsTableBody");
  const meta = el("recruiterDecisionsHeaderMeta");
  if (meta) meta.textContent = "Loading…";
  if (!body) return;
  try {
    const rows = await fetchData("/api/recruiter/decision-snapshot");
    recruiterDecisionsRows = Array.isArray(rows) ? rows : [];
    populateDecisionsAlgoFilter(recruiterDecisionsRows);
    renderRecruiterDecisionsTable();
    recruiterDecisionsLoaded = true;
  } catch (e) {
    console.error("decision snapshot:", e);
    recruiterDecisionsRows = [];
    body.replaceChildren();
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="5" class="text-secondary small">Could not load decision snapshot.</td>';
    body.appendChild(tr);
  }
}

function initDecisionsAlgoFilter() {
  const sel = el("decisionsAlgoFilter");
  if (!sel || sel.dataset.bound === "1") return;
  sel.dataset.bound = "1";
  sel.addEventListener("change", () => renderRecruiterDecisionsTable());
}

async function loadTransparencyFeed(email) {
  const ul = el("transparencyNoticesList");
  const expl = el("transparencyExplainSample");
  if (expl) {
    expl.textContent =
      "Transparency requests for your account load below; factor detail uses the same API as “View factors” on Ranked talent.";
  }
  if (!ul) return;
  try {
    const rows = await fetchData(`/api/seeker/transparency-feed?email=${encodeURIComponent(email)}`);
    ul.replaceChildren();
    if (!Array.isArray(rows) || !rows.length) {
      const li = document.createElement("li");
      li.className = "text-secondary small";
      li.textContent = "No transparency portal requests on file.";
      ul.appendChild(li);
      transparencyLoaded = true;
      return;
    }
    for (const r of rows) {
      const li = document.createElement("li");
      li.className = "mb-2 border-bottom pb-2";
      li.innerHTML = `<strong>Request #${r.requestId}</strong> — ${escapeHtml(r.requestStatus || "—")} <span class="text-secondary">· ${escapeHtml(r.detail || "")}</span>`;
      ul.appendChild(li);
    }
    transparencyLoaded = true;
  } catch (e) {
    console.error("transparency feed:", e);
    ul.replaceChildren();
    const li = document.createElement("li");
    li.className = "text-secondary small";
    li.textContent = "Could not load transparency feed.";
    ul.appendChild(li);
  }
}

async function loadDecisionsRankPreview() {
  const ol = el("mockRankedCandidates");
  if (!ol) return;
  try {
    const rows = await fetchData("/api/recruiter/ranked-talent");
    ol.replaceChildren();
    const top = (Array.isArray(rows) ? rows : []).slice(0, 5);
    if (!top.length) {
      const li = document.createElement("li");
      li.className = "text-secondary small";
      li.textContent = "No seeker-role users in the database to rank.";
      ol.appendChild(li);
      decisionsRankPreviewLoaded = true;
      return;
    }
    for (const r of top) {
      const fit = Number(r.aiFit || 0);
      const li = document.createElement("li");
      li.innerHTML = `${escapeHtml(r.candidateName || "?")} — fit <strong>${fit.toFixed(2)}</strong> · ${escapeHtml(r.signals || "")}`;
      ol.appendChild(li);
    }
    decisionsRankPreviewLoaded = true;
  } catch (e) {
    console.error("rank preview:", e);
    ol.replaceChildren();
    const li = document.createElement("li");
    li.className = "text-secondary small";
    li.textContent = "Could not load ranked preview.";
    ol.appendChild(li);
  }
}

function initLazyDataTabs() {
  const jobsTab = el("tab-jobs");
  if (jobsTab && jobsTab.dataset.lazyBound !== "1") {
    jobsTab.dataset.lazyBound = "1";
    jobsTab.addEventListener("shown.bs.tab", () => {
      const s = getSession();
      if (s?.role === "seeker" && !jobsLoaded) void loadJobMatches(s.email);
    });
  }
  const profileTab = el("tab-profile");
  if (profileTab && profileTab.dataset.lazyBound !== "1") {
    profileTab.dataset.lazyBound = "1";
    profileTab.addEventListener("shown.bs.tab", () => {
      const s = getSession();
      if (s?.role === "seeker" && !profileLoaded) void loadProfileFromApi(s.email);
    });
  }
  const decTab = el("tab-decisions");
  if (decTab && decTab.dataset.lazyBound !== "1") {
    decTab.dataset.lazyBound = "1";
    decTab.addEventListener("shown.bs.tab", () => {
      const s = getSession();
      if (!s) return;
      if (s.role === "seeker" && !seekerDecisionsLoaded) void loadSeekerDecisions(s.email);
      if (
        (s.role === "recruiter" || s.role === "admin" || s.role === "auditor") &&
        !recruiterDecisionsLoaded
      ) {
        void loadRecruiterDecisions();
      }
      if (
        (s.role === "recruiter" || s.role === "admin") &&
        !decisionsRankPreviewLoaded
      ) {
        void loadDecisionsRankPreview();
      }
    });
  }
  const transpTab = el("tab-transparency");
  if (transpTab && transpTab.dataset.lazyBound !== "1") {
    transpTab.dataset.lazyBound = "1";
    transpTab.addEventListener("shown.bs.tab", () => {
      const s = getSession();
      if (s?.role === "seeker" && !transparencyLoaded) void loadTransparencyFeed(s.email);
      if (
        (s?.role === "recruiter" || s?.role === "admin") &&
        !explainabilityRecruiterLoaded
      ) {
        void loadExplainabilityRecruiterContent();
      }
    });
  }
}

async function loadExplainabilityRecruiterContent() {
  const algoBody = el("algorithmsLibraryBody");
  const policyBody = el("policyGuideTableBody");
  const modelCmpBody = el("modelComparisonBody");
  if (!algoBody || !policyBody) return;
  try {
    const [algorithms, criteria, comparison] = await Promise.all([
      fetchData("/api/algorithms"),
      fetchData("/api/scoring-criteria"),
      fetchData("/api/recruiter/model-impact-comparison"),
    ]);
    algoBody.replaceChildren();
    const algList = Array.isArray(algorithms) ? algorithms : [];
    if (!algList.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td colspan="4" class="text-secondary small">No algorithms on file.</td>';
      algoBody.appendChild(tr);
    } else {
      for (const a of [...algList].sort((x, y) => (x.algoId ?? 0) - (y.algoId ?? 0))) {
        const tr = document.createElement("tr");
        const dt = a.lastAuditDate != null ? String(a.lastAuditDate).slice(0, 10) : "—";
        tr.innerHTML = `
          <td>${escapeHtml(a.modelName || "—")}</td>
          <td>${escapeHtml(a.vendor || "—")}</td>
          <td>${escapeHtml(a.version || "—")}</td>
          <td>${escapeHtml(dt)}</td>`;
        algoBody.appendChild(tr);
      }
    }
    policyBody.replaceChildren();
    const crList = Array.isArray(criteria) ? criteria : [];
    if (!crList.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td colspan="3" class="text-secondary small">No policy rules on file.</td>';
      policyBody.appendChild(tr);
    } else {
      for (const c of [...crList].sort((x, y) => (x.criteriaId ?? 0) - (y.criteriaId ?? 0))) {
        const tr = document.createElement("tr");
        const minY = c.minExperience != null ? String(c.minExperience) : "—";
        tr.innerHTML = `
          <td>${escapeHtml(c.jobTitle || "—")}</td>
          <td class="small">${escapeHtml(c.requiredSkills || "—")}</td>
          <td class="text-end">${escapeHtml(minY)}</td>`;
        policyBody.appendChild(tr);
      }
    }

    if (modelCmpBody) {
      modelCmpBody.replaceChildren();
      const comp = Array.isArray(comparison) ? comparison : [];
      if (!comp.length) {
        const tr = document.createElement("tr");
        tr.innerHTML =
          '<td colspan="5" class="text-secondary small">No decision factors loaded for comparison.</td>';
        modelCmpBody.appendChild(tr);
      } else {
        const sorted = [...comp].sort((a, b) => Number(b.avgImpact || 0) - Number(a.avgImpact || 0));
        for (const row of sorted) {
          const tr = document.createElement("tr");
          const avg = Number(row.avgImpact ?? 0);
          const mn = Number(row.minImpact ?? 0);
          const mx = Number(row.maxImpact ?? 0);
          tr.innerHTML = `
            <td>${escapeHtml(row.modelName || "—")}</td>
            <td class="text-end">${escapeHtml(String(row.factorCount ?? "—"))}</td>
            <td class="text-end fw-semibold">${escapeHtml(avg.toFixed(2))}</td>
            <td class="text-end">${escapeHtml(mn.toFixed(2))}</td>
            <td class="text-end">${escapeHtml(mx.toFixed(2))}</td>`;
          modelCmpBody.appendChild(tr);
        }
      }
    }

    explainabilityRecruiterLoaded = true;
  } catch (e) {
    console.error("explainability (recruiter):", e);
    algoBody.replaceChildren();
    policyBody.replaceChildren();
    if (modelCmpBody) {
      modelCmpBody.replaceChildren();
      const tr0 = document.createElement("tr");
      tr0.innerHTML = '<td colspan="5" class="text-secondary small">Could not load model comparison.</td>';
      modelCmpBody.appendChild(tr0);
    }
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="4" class="text-secondary small">Could not load algorithms.</td>';
    algoBody.appendChild(tr);
    const tr2 = document.createElement("tr");
    tr2.innerHTML = '<td colspan="3" class="text-secondary small">Could not load policy rules.</td>';
    policyBody.appendChild(tr2);
  }
}

function initResolveReviewModalReset() {
  const modalEl = el("modalResolveReview");
  if (!modalEl || modalEl.dataset.resetBound === "1") return;
  modalEl.dataset.resetBound = "1";
  modalEl.addEventListener("hidden.bs.modal", () => {
    const ctxLoad = el("modalResolveContextLoading");
    const ctxBlocks = el("modalResolveContextBlocks");
    const pol = el("modalResolvePolicyContent");
    const polErr = el("modalResolvePolicyError");
    const c = el("modalResolveFactorsContent");
    const fe = el("modalResolveFactorsError");
    const justification = el("resolveHumanJustification");
    const finalSel = el("resolveFinalAction");
    const topErr = el("modalResolveReviewError");
    const submitBtn = el("btnSubmitFinalResolution");
    if (ctxLoad) {
      ctxLoad.classList.remove("d-none");
      ctxLoad.textContent = "Loading review context…";
    }
    if (ctxBlocks) ctxBlocks.classList.add("d-none");
    const polGapWrap = el("modalResolvePolicyComparisonWrap");
    const polGap = el("modalResolvePolicyComparisonContent");
    if (polGapWrap) polGapWrap.classList.add("d-none");
    if (polGap) polGap.innerHTML = "";
    if (pol) pol.innerHTML = "";
    if (polErr) {
      polErr.classList.add("d-none");
      polErr.textContent = "";
    }
    if (c) c.innerHTML = "";
    if (fe) {
      fe.classList.add("d-none");
      fe.textContent = "";
    }
    if (justification) justification.value = "";
    if (finalSel) finalSel.selectedIndex = 0;
    if (submitBtn) submitBtn.disabled = true;
    if (topErr) {
      topErr.classList.add("d-none");
      topErr.textContent = "";
    }
  });
}

function syncResolveSubmitEnabled() {
  const ta = el("resolveHumanJustification");
  const btn = el("btnSubmitFinalResolution");
  if (!btn) return;
  const ok = ta && ta.value.trim().length > 0;
  btn.disabled = !ok;
}

function initResolveJustificationGate() {
  const ta = el("resolveHumanJustification");
  if (!ta || ta.dataset.gateBound === "1") return;
  ta.dataset.gateBound = "1";
  ta.addEventListener("input", () => syncResolveSubmitEnabled());
  ta.addEventListener("change", () => syncResolveSubmitEnabled());
}

async function loadEthicsComplianceBanner() {
  const banner = el("ethicsComplianceBanner");
  const label = el("ethicsQueueCountLabel");
  if (!banner || !label) return;
  const session = getSession();
  if (!session || (session.role !== "admin" && session.role !== "auditor")) {
    return;
  }
  try {
    const data = await fetchData("/api/compliance/ethics-pending-count");
    const n = Number(data?.count ?? 0);
    label.textContent = String(n);
    banner.classList.toggle("d-none", n <= 0);
  } catch {
    banner.classList.add("d-none");
  }
}

function updatePageSubtitle() {
  const sub = el("pageSubtitle");
  if (!sub) return;
  const d = new Date().toISOString().slice(0, 10);
  sub.textContent = `Today · ${d}`;
}

function renderAuditTable() {
  const body = el("auditTableBody");
  const countLabel = el("auditCount");
  if (!body || !countLabel) return;

  const rows = auditLogRows.filter((e) => {
    if (auditFilter === "all") return true;
    if (auditFilter === "match") return e.type === "job_match";
    if (auditFilter === "rank") return e.type === "candidate_rank" || e.type === "audit_view";
    if (auditFilter === "review") return e.type === "human_review";
    return true;
  });

  countLabel.textContent = `${rows.length} events`;

  body.replaceChildren();
  for (const e of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><time datetime="${escapeHtml(e.time)}">${escapeHtml(e.time)}</time></td>
      <td>${formatType(e.type)}</td>
      <td>${escapeHtml(e.subject)}</td>
      <td>${escapeHtml(e.policy)}</td>
      <td>${escapeHtml(e.outcome)}</td>
    `;
    body.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scoreBadgeClass(score) {
  if (score >= 0.9) return "text-bg-success";
  if (score >= 0.8) return "text-bg-primary";
  return "text-bg-secondary";
}

function renderRankedTalentRows(rows) {
  const body = el("rankedTalentTableBody");
  if (!body) return;
  body.replaceChildren();

  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="7" class="text-secondary small">No ranked candidates found.</td>';
    body.appendChild(tr);
    return;
  }

  for (const row of rows) {
    const fit = Number(row.aiFit || 0);
    const uid = row.userId != null ? String(row.userId) : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.rank)}</td>
      <td>${escapeHtml(row.candidateName || "Unknown")}</td>
      <td>${escapeHtml(row.requisition || "—")}</td>
      <td class="text-end"><span class="badge ${scoreBadgeClass(fit)}">${fit.toFixed(2)}</span></td>
      <td class="small">${escapeHtml(row.signals || "")}</td>
      <td><code class="small">${escapeHtml(row.runId || "")}</code></td>
      <td class="text-end">
        <button type="button" class="btn btn-outline-primary btn-sm btn-view-factors" data-user-id="${escapeHtml(uid)}">
          View factors
        </button>
      </td>
    `;
    body.appendChild(tr);
  }
}

function renderDecisionFactorBars(factors) {
  if (!Array.isArray(factors) || !factors.length) {
    return '<p class="small text-secondary mb-0">No decision factors linked to this candidate in the database.</p>';
  }
  return factors
    .map((f) => {
      const score = Number(f.impactScore ?? 0);
      const pct = Math.min(100, Math.max(0, Math.round(score * 100)));
      const model = f.modelName || "Decision model";
      const fname = (f.factorName && String(f.factorName).trim()) || `Factor ${f.factorId}`;
      const jobHint = f.benchmarkJobTitle ? ` · ${escapeHtml(String(f.benchmarkJobTitle))}` : "";
      const benchParts = [];
      if (f.benchmarkMinExperience != null && f.benchmarkMinExperience !== "") {
        benchParts.push(`Min experience: ${f.benchmarkMinExperience} yrs`);
      }
      const rs = f.benchmarkRequiredSkills != null ? String(f.benchmarkRequiredSkills).trim() : "";
      if (rs) benchParts.push(`Skills: ${rs}`);
      const benchLine =
        benchParts.length > 0
          ? `<div class="small mb-1"><span class="fw-semibold text-secondary">Required benchmark:</span> <span class="text-muted">${escapeHtml(benchParts.join(" · "))}</span></div>`
          : `<div class="small text-muted mb-1"><span class="fw-semibold text-secondary">Required benchmark:</span> — <span class="text-muted">(no scoring row linked for this model)</span></div>`;
      return `
      <div class="mb-3">
        <div class="d-flex justify-content-between small mb-1">
          <span><strong>${escapeHtml(fname)}</strong> <span class="text-muted">(${escapeHtml(model)}${jobHint})</span></span>
          <span class="text-muted fw-semibold">${score.toFixed(2)}</span>
        </div>
        ${benchLine}
        <div class="progress" style="height: 10px" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-bar" style="width: ${pct}%; background-color: var(--hm-teal, #0d9488)"></div>
        </div>
      </div>`;
    })
    .join("");
}

function renderPolicyComparisonBox(gap) {
  const missing = Array.isArray(gap?.missingSkills) ? gap.missingSkills : [];
  const lines = Array.isArray(gap?.policyLines) ? gap.policyLines : [];
  let html = "";
  if (lines.length) {
    html += '<p class="mb-1 fw-semibold">Linked policy (scoring criteria)</p><ul class="mb-2 ps-3">';
    for (const line of lines) {
      html += `<li>${escapeHtml(line)}</li>`;
    }
    html += "</ul>";
  }
  if (missing.length) {
    html +=
      '<p class="mb-1 fw-semibold">Missing vs. policy wording <span class="text-danger">(likely contributors to low scores)</span></p><ul class="mb-0 ps-3">';
    for (const m of missing) {
      html += `<li class="fw-bold text-danger">${escapeHtml(m)}</li>`;
    }
    html += "</ul>";
  } else if (lines.length) {
    html +=
      '<p class="small text-success mb-0">No required-skill tokens from policy appear missing against candidate signals.</p>';
  } else {
    html = '<p class="small text-secondary mb-0">No policy criteria linked for this candidate.</p>';
  }
  return html;
}

async function openDecisionFactorsModal(userId) {
  const modalEl = el("modalDecisionFactors");
  const subtitle = el("modalDecisionFactorsSubtitle");
  const loading = el("modalDecisionFactorsLoading");
  const errBox = el("modalDecisionFactorsError");
  const content = el("modalDecisionFactorsContent");

  if (!modalEl) return;

  if (subtitle) subtitle.textContent = "";
  if (loading) {
    loading.classList.remove("d-none");
    loading.textContent = "Loading decision factors…";
  }
  if (errBox) {
    errBox.classList.add("d-none");
    errBox.textContent = "";
  }
  if (content) {
    content.classList.add("d-none");
    content.innerHTML = "";
  }

  if (window.bootstrap) {
    window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
  }

  try {
    const data = await fetchData(`/api/recruiter/decision-details/${userId}`);
    if (subtitle) {
      subtitle.textContent = `Candidate: ${data.name || "Unknown"} · user_id ${data.userId ?? userId}`;
    }
    if (loading) loading.classList.add("d-none");
    if (content) {
      content.innerHTML = renderDecisionFactorBars(data.factors);
      content.classList.remove("d-none");
    }
  } catch (e) {
    if (loading) loading.classList.add("d-none");
    if (errBox) {
      const raw = String(e.message || "");
      errBox.textContent = /404|not found/i.test(raw) ? "Candidate not found." : "Connection to API failed.";
      errBox.classList.remove("d-none");
    }
    console.error("decision-details:", e);
  }
}

function initRankedTalentFactorButtons() {
  const tbody = el("rankedTalentTableBody");
  if (!tbody || tbody.dataset.factorsBound === "1") return;
  tbody.dataset.factorsBound = "1";
  tbody.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".btn-view-factors");
    if (!btn) return;
    const uid = btn.getAttribute("data-user-id");
    if (!uid) return;
    openDecisionFactorsModal(uid);
  });
}

function reviewRequestStatusBadgeClass(status) {
  const s = String(status || "").toLowerCase();
  if (s === "in progress") return "text-bg-info text-dark";
  if (s === "under review") return "text-bg-primary";
  if (s === "under ethical review") return "text-bg-dark";
  if (s === "pending") return "text-bg-warning text-dark";
  if (s === "escalated") return "text-bg-danger";
  if (s === "upheld") return "text-bg-success";
  if (s === "overturned") return "text-bg-warning text-dark";
  if (s === "adjusted") return "text-bg-warning text-dark";
  if (s === "approved") return "text-bg-success";
  if (s === "rejected") return "text-bg-danger";
  return "text-bg-secondary";
}

function reviewRequestIsFinalStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  return s === "upheld" || s === "adjusted" || s === "overturned";
}

function renderPolicyBenchmarksTable(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return '<p class="small text-secondary mb-0">No scoring criteria linked to this candidate’s algorithm benchmarks.</p>';
  }
  const head = `<thead class="table-light"><tr>
    <th scope="col">Job title</th>
    <th scope="col">Required skills</th>
    <th scope="col" class="text-end">Min experience</th>
    <th scope="col" class="small">Criteria · model</th>
  </tr></thead>`;
  const body = rows
    .map((r) => {
      const minY = r.minExperience != null && r.minExperience !== "" ? String(r.minExperience) : "—";
      const crit = r.criteriaId != null ? `#${r.criteriaId}` : "—";
      const model = r.modelName || "—";
      const algo = r.algoId != null ? `algo ${r.algoId}` : "";
      const tail = algo ? `${escapeHtml(crit)} · ${escapeHtml(model)} (${escapeHtml(algo)})` : `${escapeHtml(crit)} · ${escapeHtml(model)}`;
      return `<tr>
        <td>${escapeHtml(r.jobTitle || "—")}</td>
        <td class="small">${escapeHtml(r.requiredSkills || "—")}</td>
        <td class="text-end">${escapeHtml(minY)}</td>
        <td class="small text-muted">${tail}</td>
      </tr>`;
    })
    .join("");
  return `<div class="table-responsive"><table class="table table-sm table-bordered mb-0">${head}<tbody>${body}</tbody></table></div>`;
}

function updateReviewerWorkstationProfile() {
  const sel = el("reviewReviewerSelect");
  const body = el("reviewerWorkstationProfileBody");
  if (!sel || !body) return;
  const opt = sel.selectedOptions[0];
  if (!opt || !opt.value) {
    body.textContent = "Select yourself in the list to load certification and attribute.";
    return;
  }
  const cert = (opt.dataset.certificationLevel || "").trim() || "—";
  const attr = (opt.dataset.attribute || "").trim() || "—";
  const label = opt.textContent.trim();
  body.innerHTML = `${escapeHtml(label)} — <span class="text-secondary">Certification:</span> ${escapeHtml(cert)} · <span class="text-secondary">Attribute:</span> ${escapeHtml(attr)}`;
}

function tryPrefillReviewerFromSession() {
  const sel = el("reviewReviewerSelect");
  const session = getSession();
  if (!sel || !session?.name) return;
  if (sel.value) return;
  const needle = session.name.trim().toLowerCase();
  for (const opt of sel.options) {
    if (!opt.value) continue;
    if (opt.textContent.toLowerCase().includes(needle)) {
      sel.value = opt.value;
      break;
    }
  }
}

function bindReviewerSelectProfileOnce() {
  const sel = el("reviewReviewerSelect");
  if (!sel || sel.dataset.profileBound === "1") return;
  sel.dataset.profileBound = "1";
  sel.addEventListener("change", () => updateReviewerWorkstationProfile());
}

async function ensureReviewerSelectLoaded() {
  const sel = el("reviewReviewerSelect");
  if (!sel || sel.dataset.loaded === "1") return;
  try {
    const list = await fetchData("/api/reviewers");
    sel.replaceChildren();
    if (!Array.isArray(list) || !list.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No reviewers in database";
      sel.appendChild(opt);
      sel.dataset.loaded = "1";
      bindReviewerSelectProfileOnce();
      updateReviewerWorkstationProfile();
      return;
    }
    for (const r of [...list].sort((a, b) => a.reviewerId - b.reviewerId)) {
      const opt = document.createElement("option");
      opt.value = String(r.reviewerId);
      opt.textContent = `${r.employeeName} (#${r.reviewerId})`;
      opt.dataset.certificationLevel = r.certificationLevel ?? "";
      opt.dataset.attribute = r.attribute ?? "";
      sel.appendChild(opt);
    }
    sel.dataset.loaded = "1";
    bindReviewerSelectProfileOnce();
    tryPrefillReviewerFromSession();
    updateReviewerWorkstationProfile();
  } catch (e) {
    console.error("reviewers load:", e);
    sel.replaceChildren();
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Could not load reviewers";
    sel.appendChild(opt);
    bindReviewerSelectProfileOnce();
    updateReviewerWorkstationProfile();
  }
}

async function claimReviewRequest(requestId) {
  const sel = el("reviewReviewerSelect");
  const reviewerId = sel && sel.value ? parseInt(sel.value, 10) : NaN;
  if (!Number.isFinite(reviewerId)) {
    const msg = el("reviewRequestsApiMessage");
    if (msg) {
      msg.textContent = "Select a reviewer in the dropdown before claiming.";
      msg.classList.remove("d-none");
    }
    return;
  }
  showApiMessage("reviewRequestsApiMessage", "");
  try {
    await fetchData("/api/recruiter/claim-review", {
      method: "POST",
      body: JSON.stringify({ requestId, reviewerId }),
    });
    await loadReviewRequests();
  } catch (e) {
    const raw = String(e.message || "");
    const conflict = /409|already assigned|Conflict/i.test(raw);
    showApiMessage(
      "reviewRequestsApiMessage",
      conflict ? "This request was already claimed." : "Connection to API failed."
    );
    console.error("claim-review:", e);
  }
}

async function openResolveReviewModal(requestId, applicantUserId) {
  const hiddenR = el("resolveReviewRequestId");
  const hiddenA = el("resolveApplicantUserId");
  const err = el("modalResolveReviewError");
  const errFactors = el("modalResolveFactorsError");
  const errPolicy = el("modalResolvePolicyError");
  const ctxLoad = el("modalResolveContextLoading");
  const ctxBlocks = el("modalResolveContextBlocks");
  const polContent = el("modalResolvePolicyContent");
  const contentEl = el("modalResolveFactorsContent");
  const justificationEl = el("resolveHumanJustification");
  const finalSel = el("resolveFinalAction");
  const submitBtn = el("btnSubmitFinalResolution");
  const modalEl = el("modalResolveReview");

  if (hiddenR) hiddenR.value = String(requestId);
  if (hiddenA) hiddenA.value = Number.isFinite(applicantUserId) ? String(applicantUserId) : "";
  if (justificationEl) justificationEl.value = "";
  if (finalSel) finalSel.selectedIndex = 0;
  if (submitBtn) submitBtn.disabled = true;
  if (err) {
    err.classList.add("d-none");
    err.textContent = "";
  }
  if (errFactors) {
    errFactors.classList.add("d-none");
    errFactors.textContent = "";
  }
  if (errPolicy) {
    errPolicy.classList.add("d-none");
    errPolicy.textContent = "";
  }
  if (polContent) polContent.innerHTML = "";
  if (contentEl) contentEl.innerHTML = "";
  if (ctxBlocks) ctxBlocks.classList.add("d-none");
  if (ctxLoad) {
    ctxLoad.classList.remove("d-none");
    ctxLoad.textContent = "Loading review context…";
  }

  if (modalEl && window.bootstrap) {
    window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
  }

  const showBlocksAndHideLoader = () => {
    if (ctxLoad) ctxLoad.classList.add("d-none");
    if (ctxBlocks) ctxBlocks.classList.remove("d-none");
  };

  if (!Number.isFinite(applicantUserId)) {
    showBlocksAndHideLoader();
    const gw = el("modalResolvePolicyComparisonWrap");
    const gc = el("modalResolvePolicyComparisonContent");
    if (gw) gw.classList.add("d-none");
    if (gc) gc.innerHTML = "";
    if (errPolicy) {
      errPolicy.textContent = "Applicant user id missing; policy benchmarks cannot be loaded.";
      errPolicy.classList.remove("d-none");
    }
    if (errFactors) {
      errFactors.textContent = "Applicant record is missing; decision factors cannot be loaded.";
      errFactors.classList.remove("d-none");
    }
    return;
  }

  const gapWrap = el("modalResolvePolicyComparisonWrap");
  const gapContent = el("modalResolvePolicyComparisonContent");

  try {
    const [detailsRes, policyRes, gapRes] = await Promise.allSettled([
      fetchData(`/api/recruiter/decision-details/${applicantUserId}`),
      fetchData(`/api/recruiter/candidate-policy-benchmarks/${applicantUserId}`),
      fetchData(`/api/recruiter/candidate-policy-gap/${applicantUserId}`),
    ]);

    showBlocksAndHideLoader();

    if (gapWrap && gapContent) {
      gapContent.innerHTML = "";
      if (gapRes.status === "fulfilled") {
        gapContent.innerHTML = renderPolicyComparisonBox(gapRes.value);
        gapWrap.classList.remove("d-none");
      } else {
        gapContent.innerHTML =
          '<p class="text-warning small mb-0">Could not load policy comparison.</p>';
        gapWrap.classList.remove("d-none");
      }
    }

    if (polContent && errPolicy) {
      errPolicy.classList.add("d-none");
      if (policyRes.status === "fulfilled") {
        polContent.innerHTML = renderPolicyBenchmarksTable(policyRes.value);
      } else {
        polContent.innerHTML = "";
        const raw = String(policyRes.reason?.message || policyRes.reason || "");
        errPolicy.textContent = /404|not found/i.test(raw)
          ? "Candidate not found for policy benchmarks."
          : "Could not load scoring criteria / algorithm benchmarks.";
        errPolicy.classList.remove("d-none");
        console.error("resolve modal policy:", policyRes.reason);
      }
    }

    if (contentEl && errFactors) {
      errFactors.classList.add("d-none");
      if (detailsRes.status === "fulfilled") {
        const data = detailsRes.value;
        const uid = data.userId ?? applicantUserId;
        const head = `<p class="small text-secondary mb-2">Candidate: <strong>${escapeHtml(data.name || "—")}</strong> · user <code>${escapeHtml(String(uid))}</code></p>`;
        contentEl.innerHTML = head + renderDecisionFactorBars(data.factors);
      } else {
        contentEl.innerHTML = "";
        const raw = String(detailsRes.reason?.message || detailsRes.reason || "");
        errFactors.textContent = /404|not found/i.test(raw)
          ? "No decision factors on file for this applicant."
          : "Could not load decision factors.";
        errFactors.classList.remove("d-none");
        console.error("resolve modal factors:", detailsRes.reason);
      }
    }
  } catch (e) {
    showBlocksAndHideLoader();
    console.error("resolve modal context:", e);
  }
}

function openAddressReviewModal(requestId) {
  const hidden = el("addressReviewRequestId");
  const ta = el("addressReviewSummary");
  const errBox = el("modalAddressReviewError");
  const modalEl = el("modalAddressReview");
  if (hidden) hidden.value = String(requestId);
  if (ta) ta.value = "";
  if (errBox) {
    errBox.classList.add("d-none");
    errBox.textContent = "";
  }
  if (modalEl && window.bootstrap) {
    window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
  }
}

async function submitAddressReview() {
  const hidden = el("addressReviewRequestId");
  const ta = el("addressReviewSummary");
  const errBox = el("modalAddressReviewError");
  const modalEl = el("modalAddressReview");
  const requestId = hidden && hidden.value ? parseInt(hidden.value, 10) : NaN;
  const summary = ta ? ta.value.trim() : "";

  if (errBox) {
    errBox.classList.add("d-none");
    errBox.textContent = "";
  }

  if (!Number.isFinite(requestId)) return;
  if (!summary) {
    if (errBox) {
      errBox.textContent = "Enter a short summary of how you addressed the request.";
      errBox.classList.remove("d-none");
    }
    return;
  }

  showApiMessage("reviewRequestsApiMessage", "");
  try {
    await fetchData("/api/recruiter/address-review", {
      method: "POST",
      body: JSON.stringify({ requestId, summary }),
    });
    if (modalEl && window.bootstrap) {
      window.bootstrap.Modal.getOrCreateInstance(modalEl).hide();
    }
    await loadReviewRequests();
  } catch (e) {
    const raw = String(e.message || "");
    if (errBox) {
      errBox.textContent = /400|Only requests In Progress|Bad Request/i.test(raw)
        ? "You can only add an address note while the request is In Progress."
        : "Connection to API failed.";
      errBox.classList.remove("d-none");
    }
    console.error("address-review:", e);
  }
}

async function submitResolveReview() {
  const hidden = el("resolveReviewRequestId");
  const err = el("modalResolveReviewError");
  const modalEl = el("modalResolveReview");
  const finalSel = el("resolveFinalAction");
  const requestId = hidden && hidden.value ? parseInt(hidden.value, 10) : NaN;
  if (!Number.isFinite(requestId)) return;

  const finalAction = finalSel && finalSel.value ? finalSel.value.trim() : "Upheld";
  const justificationEl = el("resolveHumanJustification");
  const humanJustification = justificationEl ? justificationEl.value.trim() : "";
  if (!humanJustification) {
    if (err) {
      err.textContent = "Human justification is required.";
      err.classList.remove("d-none");
    }
    return;
  }

  if (err) {
    err.classList.add("d-none");
    err.textContent = "";
  }

  showApiMessage("reviewRequestsApiMessage", "");

  try {
    await fetchData("/api/recruiter/resolve-review", {
      method: "POST",
      body: JSON.stringify({ requestId, finalAction, humanJustification }),
    });
    if (modalEl && window.bootstrap) {
      window.bootstrap.Modal.getOrCreateInstance(modalEl).hide();
    }
    await loadReviewRequests();
  } catch (e) {
    const raw = String(e.message || "");
    if (err) {
      err.textContent = /400|Only requests In Progress|Bad Request|finalAction|humanJustification/i.test(raw)
        ? "This request cannot be resolved (must be In Progress), or justification / final action was rejected."
        : "Connection to API failed.";
      err.classList.remove("d-none");
    }
    console.error("resolve-review:", e);
  }
}

function initResolveReviewModalSubmit() {
  const btn = el("btnSubmitFinalResolution");
  if (!btn || btn.dataset.resolveSubmitBound === "1") return;
  btn.dataset.resolveSubmitBound = "1";
  btn.addEventListener("click", () => void submitResolveReview());
}

function initReviewRequestTableActions() {
  const tbody = el("reviewRequestsTableBody");
  if (!tbody || tbody.dataset.tableActionsBound === "1") return;
  tbody.dataset.tableActionsBound = "1";
  tbody.addEventListener("click", (ev) => {
    const claimBtn = ev.target.closest(".btn-claim-review");
    if (claimBtn) {
      const rid = claimBtn.getAttribute("data-request-id");
      if (rid) claimReviewRequest(parseInt(rid, 10));
      return;
    }
    const addressBtn = ev.target.closest(".btn-address-review");
    if (addressBtn) {
      const rid = addressBtn.getAttribute("data-request-id");
      if (rid) openAddressReviewModal(parseInt(rid, 10));
      return;
    }
    const ethicsBtn = ev.target.closest(".btn-escalate-ethics");
    if (ethicsBtn) {
      const rid = ethicsBtn.getAttribute("data-request-id");
      if (rid) void submitEthicsEscalation(parseInt(rid, 10));
      return;
    }
    const resolveBtn = ev.target.closest(".btn-resolve-review");
    if (resolveBtn) {
      const rid = resolveBtn.getAttribute("data-request-id");
      const aid = resolveBtn.getAttribute("data-applicant-user-id");
      if (rid) {
        const uid = aid ? parseInt(aid, 10) : NaN;
        void openResolveReviewModal(parseInt(rid, 10), uid);
      }
    }
  });
}

async function submitEthicsEscalation(requestId) {
  if (
    !confirm(
      "Escalate to Ethics Board? Status becomes Under Ethical Review; Admin and Auditor workstations surface this queue."
    )
  ) {
    return;
  }
  showApiMessage("reviewRequestsApiMessage", "");
  try {
    await fetchData("/api/recruiter/escalate-ethics-review", {
      method: "POST",
      body: JSON.stringify({ requestId }),
    });
    await loadReviewRequests();
    await loadEthicsComplianceBanner();
  } catch (e) {
    const raw = String(e.message || "");
    showApiMessage(
      "reviewRequestsApiMessage",
      /400|fairness|Bad Request|Ethics/i.test(raw)
        ? "Ethics escalation failed (must be In Progress with fairness-flagged applicant)."
        : "Connection to API failed."
    );
    console.error("escalate-ethics-review:", e);
  }
}

function initAddressReviewModal() {
  const btn = el("btnSubmitAddressReview");
  if (!btn || btn.dataset.addressBound === "1") return;
  btn.dataset.addressBound = "1";
  btn.addEventListener("click", () => void submitAddressReview());
}

function renderReviewRequestRows(rows) {
  const body = el("reviewRequestsTableBody");
  const count = el("reviewRequestsOpenCount");
  if (!body) return;

  body.replaceChildren();
  const list = Array.isArray(rows) ? rows : [];
  const openCount = list.filter((r) => !reviewRequestIsFinalStatus(r.status)).length;
  if (count) count.textContent = `${openCount} open / ${list.length} total`;

  if (!list.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="11" class="text-secondary small">No review requests in the queue.</td>';
    body.appendChild(tr);
    return;
  }

  const applicantUid = (row) =>
    row.applicantUserId != null && row.applicantUserId !== undefined
      ? String(row.applicantUserId)
      : "";

  for (const row of list) {
    const hasReviewer = row.reviewerId != null && row.reviewerId !== undefined;
    const rid = row.requestId != null ? String(row.requestId) : "";
    const aid = applicantUid(row);
    const statusNorm = String(row.status || "").trim().toLowerCase();
    const isInProgress = statusNorm === "in progress";
    const canClaim =
      !hasReviewer &&
      (statusNorm === "pending" ||
        statusNorm === "escalated" ||
        statusNorm === "under ethical review");
    const statusClass = reviewRequestStatusBadgeClass(row.status);
    const reviewerCell = hasReviewer
      ? escapeHtml(row.reviewerName || `Reviewer #${row.reviewerId}`)
      : "—";

    const ratio = row.fairnessImpactRatio != null ? Number(row.fairnessImpactRatio) : null;
    const fairnessFlag = ratio != null && !Number.isNaN(ratio) && ratio < 0.7;
    const ratioText = ratio != null && !Number.isNaN(ratio) ? ratio.toFixed(2) : "—";
    const fairnessCell = fairnessFlag
      ? `<span class="badge text-bg-danger me-1" data-bs-toggle="tooltip" data-bs-title="Latest recorded impact ratio for this applicant is below the 0.70 fairness threshold.">Fairness Flag</span><span class="small text-muted">${escapeHtml(ratioText)}</span>`
      : `<span class="small">${escapeHtml(ratioText)}</span>`;

    let actionCell = '<span class="text-secondary small">—</span>';
    if (canClaim) {
      const label =
        statusNorm === "escalated"
          ? "Claim (manager)"
          : statusNorm === "under ethical review"
            ? "Claim (ethics)"
            : "Claim request";
      actionCell = `<button type="button" class="btn btn-sm btn-outline-primary btn-claim-review" data-request-id="${escapeHtml(rid)}">${escapeHtml(label)}</button>`;
    } else if (isInProgress) {
      const ethicsBtn = fairnessFlag
        ? `<button type="button" class="btn btn-sm btn-outline-danger btn-escalate-ethics" data-request-id="${escapeHtml(rid)}">Escalate to Ethics Board</button>`
        : "";
      actionCell = `<div class="d-flex flex-wrap gap-1 justify-content-end" role="group" aria-label="Request actions">
        ${ethicsBtn}
        <button type="button" class="btn btn-sm btn-outline-secondary btn-address-review" data-request-id="${escapeHtml(rid)}">Address</button>
        <button type="button" class="btn btn-sm btn-outline-success btn-resolve-review" data-request-id="${escapeHtml(rid)}" data-applicant-user-id="${escapeHtml(aid)}">Resolve</button>
      </div>`;
    }

    const tr = document.createElement("tr");
    if (fairnessFlag) {
      tr.classList.add("table-danger");
    }
    const specialist = row.suggestedSpecialist
      ? escapeHtml(row.suggestedSpecialist)
      : '<span class="text-secondary">—</span>';
    const sourceCell = escapeHtml(row.sourceLabel || "Applicant Dispute");

    tr.innerHTML = `
      <td><code>${escapeHtml(row.ticketId || `HR-${row.requestId || "?"}`)}</code></td>
      <td>${escapeHtml(row.applicant || "Unknown")}</td>
      <td class="small">${fairnessCell}</td>
      <td class="small">${specialist}</td>
      <td class="small">${sourceCell}</td>
      <td><code>${escapeHtml(row.decisionId || `dec-${row.requestId || "?"}`)}</code></td>
      <td>${escapeHtml(row.reason || "other")}</td>
      <td>${escapeHtml(row.submittedAtUtc || "n/a")}</td>
      <td><span class="badge ${statusClass}">${escapeHtml(row.status || "Pending")}</span></td>
      <td class="small">${reviewerCell}</td>
      <td class="text-end">${actionCell}</td>
    `;
    body.appendChild(tr);
  }

  if (window.bootstrap && window.bootstrap.Tooltip) {
    body.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((node) => {
      window.bootstrap.Tooltip.getOrCreateInstance(node);
    });
  }
}

async function loadRankedTalent() {
  showApiMessage("rankedTalentApiMessage", "");
  try {
    const rows = await fetchData("/api/recruiter/ranked-talent");
    renderRankedTalentRows(Array.isArray(rows) ? rows : []);
    rankedTalentLoaded = true;
  } catch (err) {
    showApiMessage("rankedTalentApiMessage", "Connection to API failed.");
    console.error("Failed loading ranked talent:", err);
  }
}

async function loadReviewRequests() {
  showApiMessage("reviewRequestsApiMessage", "");
  try {
    await ensureReviewerSelectLoaded();
    tryPrefillReviewerFromSession();
    updateReviewerWorkstationProfile();
    const rows = await fetchData("/api/recruiter/review-requests");
    renderReviewRequestRows(Array.isArray(rows) ? rows : []);
    reviewRequestsLoaded = true;
  } catch (err) {
    showApiMessage("reviewRequestsApiMessage", "Connection to API failed.");
    console.error("Failed loading review requests:", err);
  }
}

function roleAllowedForTab(li, role) {
  const raw = li.getAttribute("data-rbac-allow") || "";
  const allowed = raw.split(/\s+/).filter(Boolean);
  return allowed.includes(role);
}

function applyRoleAccess(role) {
  document.body.dataset.appRole = role;

  const items = document.querySelectorAll("li[data-rbac-allow]");
  let mustReselect = false;

  for (const li of items) {
    const show = roleAllowedForTab(li, role);
    li.classList.toggle("d-none", !show);
    li.setAttribute("aria-hidden", show ? "false" : "true");

    const tabBtn = li.querySelector(".nav-link[data-bs-toggle='tab']");
    if (!show && tabBtn && tabBtn.classList.contains("active")) {
      mustReselect = true;
    }
  }

  if (mustReselect && window.bootstrap) {
    const firstVisible = document.querySelector(
      "li[data-rbac-allow]:not(.d-none) .nav-link[data-bs-toggle='tab']"
    );
    if (firstVisible) {
      window.bootstrap.Tab.getOrCreateInstance(firstVisible).show();
    }
  }

  updateRoleBanner(role);
  applyRolePreview(role);
}

function updateRoleBanner(role) {
  const banner = el("roleAccessBanner");
  if (!banner) return;
  const line = ROLE_BANNER[role] || "";
  banner.innerHTML =
    '<span class="d-block">' +
    escapeHtml(line) +
    "</span>" +
    '<span class="d-block mt-1 small text-muted">Sign-in is validated against the database; enforce RBAC on the API in production.</span>';
}

function applyRolePreview(role) {
  const hints = document.querySelectorAll(".data-role-hint");
  for (const node of hints) {
    const show = node.getAttribute("data-show-for") || "";
    const allow = show.split(/\s+/).filter(Boolean);
    const visible = allow.length === 0 || allow.includes(role);
    node.setAttribute("data-role-hidden", visible ? "false" : "true");
  }
}

function initAuditFilters() {
  const map = [
    ["btnFilterAll", "all"],
    ["btnFilterMatch", "match"],
    ["btnFilterRank", "rank"],
    ["btnFilterReview", "review"],
  ];
  for (const [id, key] of map) {
    const b = el(id);
    if (b) {
      b.addEventListener("click", () => {
        auditFilter = key;
        renderAuditTable();
      });
    }
  }
}

function initRankViewButton() {
  const btn = el("btnLogRankView");
  if (!btn) return;
  btn.addEventListener("click", () => {
    void appendClientAudit("Recruiter viewed ranked talent shortlist");
  });
}

function initHumanReviewForm() {
  const form = el("formHumanReview");
  const feedback = el("reviewFeedback");
  if (!form) return;

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const session = getSession();
    const decisionId =
      (el("reviewDecisionId") && el("reviewDecisionId").value.trim()) || "dec-unknown";
    const reason = el("reviewReason") ? el("reviewReason").value : "other";
    const notes = el("reviewNotes") ? el("reviewNotes").value.trim() : "";
    if (!session) return;
    if (session.role !== "seeker") {
      if (feedback) feedback.textContent = "Formal dispute is only available to applicant accounts.";
      return;
    }

    try {
      const created = await fetchData("/api/seeker/formal-dispute", {
        method: "POST",
        body: JSON.stringify({
          requesterEmail: session.email,
          decisionId,
          reason,
          notes,
        }),
      });

      await loadAuditLogs();

      if (feedback) {
        feedback.textContent = `Ticket ${created.ticketId || "HR-NEW"} created. Linked to ${decisionId}.`;
      }

      const modalEl = el("modalReviewConfirm");
      const modalBody = el("modalReviewConfirmBody");
      if (modalBody) {
        modalBody.textContent = `Ticket ${created.ticketId || "HR-NEW"} saved to backend.`;
      }
      if (modalEl && window.bootstrap) {
        const modal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
        modal.show();
      }

      form.reset();
      await loadReviewRequests();
    } catch (err) {
      if (feedback) feedback.textContent = "Connection to API failed.";
      showApiMessage("reviewRequestsApiMessage", "Connection to API failed.");
      console.error("Failed creating review request:", err);
    }
  });
}

function initRecruiterDataTabs() {
  const rankedTab = el("tab-ranked");
  if (rankedTab) {
    rankedTab.addEventListener("shown.bs.tab", () => {
      if (!rankedTalentLoaded) loadRankedTalent();
    });
  }

  const reviewTab = el("tab-review-requests");
  if (reviewTab) {
    reviewTab.addEventListener("shown.bs.tab", () => {
      if (!reviewRequestsLoaded) loadReviewRequests();
    });
  }
}

function initTabTitles() {
  const titleEl = el("pageTitle");
  document.querySelectorAll("#appView [data-bs-toggle='tab']").forEach((btn) => {
    btn.addEventListener("shown.bs.tab", () => {
      const id = btn.id;
      if (titleEl && TAB_LABELS[id]) {
        titleEl.textContent = TAB_LABELS[id];
      }
    });
  });
  const active = document.querySelector("#appView .nav-link[data-bs-toggle='tab'].active");
  if (titleEl && active && TAB_LABELS[active.id]) {
    titleEl.textContent = TAB_LABELS[active.id];
  }
}

function attachAppListenersOnce() {
  if (appListenersAttached) return;
  appListenersAttached = true;
  initAuditFilters();
  initRankViewButton();
  initHumanReviewForm();
  initRecruiterDataTabs();
  initRankedTalentFactorButtons();
  initReviewRequestTableActions();
  initResolveReviewModalSubmit();
  initResolveReviewModalReset();
  initResolveJustificationGate();
  initDecisionsAlgoFilter();
  initAddressReviewModal();
  initTabTitles();
  initLazyDataTabs();
}

function bootApp(session) {
  showAppView();
  updateSessionDisplay(session);
  applyRoleAccess(session.role);
  void loadEthicsComplianceBanner();
  void loadAuditLogs();
  updatePageSubtitle();
  void loadDashboardMetrics(session.email);
  attachAppListenersOnce();
  if (session.role === "recruiter" || session.role === "admin") {
    loadRankedTalent();
    loadReviewRequests();
  } else if (session.role === "auditor") {
    loadReviewRequests();
  }
  if (session.role === "auditor" || session.role === "admin") {
    void loadDirectoryFromApi();
  }
}

async function quickLoginByRole(targetRole) {
  try {
    const data = await fetchData("/api/auth/quick-login", {
      method: "POST",
      body: JSON.stringify({ targetRole }),
    });
    saveSession({
      email: data.email,
      name: data.name,
      role: data.role,
      department: data.department ?? "",
      jobTitle: data.jobTitle ?? "",
    });
    bootApp(getSession());
  } catch (e) {
    const raw = String(e.message || "");
    if (/404|Not Found/i.test(raw)) {
      alert("Quick login only works when the API runs in Development mode.");
    } else {
      alert("Quick login failed. Sign in with email and password.");
    }
    console.error("quick-login:", e);
  }
}

function initQuickLoginButtons() {
  const pairs = [
    ["quickLoginApplicant", "seeker"],
    ["quickLoginEmployee", "recruiter"],
    ["quickLoginAdmin", "admin"],
  ];
  for (const [id, targetRole] of pairs) {
    const btn = el(id);
    if (btn) {
      btn.addEventListener("click", () => void quickLoginByRole(targetRole));
    }
  }
}

async function loginWithApi(email, password) {
  const err = el("loginError");
  if (err) {
    err.classList.add("d-none");
    err.textContent = "";
  }
  try {
    const data = await fetchData("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    });
    saveSession({
      email: data.email,
      name: data.name,
      role: data.role,
      department: data.department ?? "",
      jobTitle: data.jobTitle ?? "",
    });
    bootApp(getSession());
  } catch (e) {
    const raw = String(e.message || "");
    if (err) {
      err.textContent =
        /401|Invalid|not registered|503|configured/i.test(raw) || /Bad Request/i.test(raw)
          ? "Invalid email or password, or auth is not configured on the server."
          : "Connection to API failed.";
      err.classList.remove("d-none");
    }
    console.error("login:", e);
  }
}

function initLoginForm() {
  const form = el("loginForm");
  if (!form) return;

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const emailInput = el("loginEmail");
    const passInput = el("loginPassword");
    const email = emailInput ? emailInput.value.trim().toLowerCase() : "";
    const password = passInput ? passInput.value : "";
    await loginWithApi(email, password);
  });
}

function initLogout() {
  const btn = el("btnLogout");
  if (!btn) return;
  btn.addEventListener("click", () => {
    clearSession();
    document.location.reload();
  });
}

function init() {
  initLoginForm();
  initQuickLoginButtons();
  initLogout();

  const session = getSession();
  if (session) {
    bootApp(session);
  } else {
    showLoginView();
  }
}

init();

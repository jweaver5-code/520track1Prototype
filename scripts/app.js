/**
 * HireMatchAI — RBAC in UI; users, audit trail, and recruiter data from the API.
 */

const SESSION_KEY = "hirematchai_session_v1";
const API_BASE_URL = (() => {
  if (typeof window !== "undefined" && typeof window.__API_BASE__ === "string" && window.__API_BASE__) {
    return window.__API_BASE__;
  }
  // Same host when UI is served from the API (e.g. http://localhost:5113/)
  if (
    typeof window !== "undefined" &&
    window.location?.protocol?.startsWith("http") &&
    (window.location.port === "5113" || window.location.port === "7226")
  ) {
    return "";
  }
  return "http://localhost:5113";
})();

/** Normalized rows for the audit log table (from GET /api/audit-logs). */
let auditLogRows = [];
let appListenersAttached = false;
let rankedTalentLoaded = false;
let reviewRequestsLoaded = false;
let jobsLoaded = false;
let profileLoaded = false;
let seekerDecisionsLoaded = false;
let recruiterDecisionsLoaded = false;
let transparencyFeedLoaded = false;
let decisionsRankPreviewLoaded = false;
let decisionsContextLoaded = false;

/** Latest GET /api/recruiter/decision-snapshot rows for client-side algorithm filter. */
let recruiterDecisionsRows = [];
/** "" | "score-desc" | "score-asc" — toggled by clicking the Score column header. */
let recruiterDecisionsSortMode = "";

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

/**
 * Compliance column + row flagging: uses impact ratio (&lt;0.70 = fairness risk) and summary keywords.
 * States: non_compliant | compliant | unsure
 */
function inferComplianceState(summary, impactRatio) {
  const s = String(summary || "").toLowerCase();
  const bad =
    /non-?compliant|violation|breach|escalat|ethical review|under ethical|overturn|unfair|flagged|penalt|sanction|\bfail\b|formal dispute/;
  const good = /\bupheld\b|\bcompliant\b|cleared|no violation|passed inspection|resolved\b.*\b(ok|pass)/;
  const r = impactRatio != null && Number.isFinite(Number(impactRatio)) ? Number(impactRatio) : null;
  if (r != null && r < 0.7) return "non_compliant";
  if (bad.test(s)) return "non_compliant";
  if (good.test(s)) return "compliant";
  if (r != null && r >= 0.7) return "compliant";
  return "unsure";
}

function complianceBadgeHtml(state) {
  if (state === "non_compliant") {
    return '<span class="badge text-bg-danger">Non-compliant</span>';
  }
  if (state === "compliant") {
    return '<span class="badge text-bg-success">Compliant</span>';
  }
  return '<span class="badge text-bg-secondary">Needs review</span>';
}

function mapApiAuditRow(row) {
  const r = row && typeof row === "object" ? row : {};
  const summary = r.complianceStatus ?? r.ComplianceStatus ?? "—";
  const ts = r.auditTimestamp ?? r.AuditTimestamp;
  const iso =
    ts != null ? String(ts).replace("T", " ").slice(0, 19) : "—";
  const type = inferAuditType(summary);
  const policyParts = [];
  const revId = r.reviewerId ?? r.ReviewerId;
  const facId = r.factorId ?? r.FactorId;
  const uid = r.userId ?? r.UserId;
  if (revId != null) policyParts.push(`reviewer ${revId}`);
  if (facId != null) policyParts.push(`factor ${facId}`);
  if (uid != null) policyParts.push(`user ${uid}`);
  const policy = policyParts.length ? policyParts.join(" · ") : "—";
  const rawImpact = r.impactRatio ?? r.ImpactRatio;
  const impactNum = rawImpact != null ? Number(rawImpact) : null;
  const outcome =
    impactNum != null && !Number.isNaN(impactNum) ? impactNum.toFixed(2) : "—";
  const compliance = inferComplianceState(summary, impactNum);
  const logId = r.logId ?? r.LogId;
  return {
    logId,
    time: iso,
    type,
    subject: summary,
    policy,
    outcome,
    impactRatio: Number.isNaN(impactNum) ? null : impactNum,
    userId: uid,
    reviewerId: revId,
    factorId: facId,
    compliance,
  };
}

async function loadAuditLogs() {
  try {
    const raw = await fetchData("/api/audit-logs");
    if (!Array.isArray(raw)) {
      auditLogRows = [];
    } else {
      auditLogRows = raw
        .map((row) => {
          try {
            return mapApiAuditRow(row);
          } catch (err) {
            console.warn("audit row skipped:", err);
            return null;
          }
        })
        .filter(Boolean);
    }
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
    setMetricText(
      "metricRecMedian",
      m.recruiter?.medianDaysInStage != null ? `${Number(m.recruiter.medianDaysInStage).toFixed(1)} days` : "—"
    );
    setMetricText("metricRecRuns", m.auditLogs7d);

    setMetricText("metricAudAudit", m.auditLogs24h);
    setMetricText("metricAudFlags", m.pendingTransparency);
    setMetricText("metricAudImpact", m.algorithmsCount);
    setMetricText("metricAudDrift", m.scoringCriteriaCount);

    setMetricText("metricDashUsers", m.usersCount);
    setMetricText("metricDashUdf", m.userDecisionFactorLinks);
    setMetricText("metricDashSeekerRoles", m.seekerRoleCount);

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
    if (!Array.isArray(rows) || !rows.length) {
      body.innerHTML = twDecisionsEmptyLine("No factors linked to your account.");
      seekerDecisionsLoaded = true;
      return;
    }
    body.innerHTML = rows.map((r) => twDecisionDashboardCard(r)).join("");
    seekerDecisionsLoaded = true;
  } catch (e) {
    console.error("decision history:", e);
    body.innerHTML = twDecisionsEmptyLine("Could not load decisions.");
  }
}

function numericDecisionScore(row) {
  const v = Number(row?.score);
  return Number.isFinite(v) ? v : null;
}

function sortDecisionSnapshotRows(rows, sortKey) {
  const list = [...rows];
  if (sortKey === "score-desc") {
    list.sort((a, b) => {
      const sa = numericDecisionScore(a);
      const sb = numericDecisionScore(b);
      if (sa == null && sb == null) return String(a.decisionId ?? "").localeCompare(String(b.decisionId ?? ""));
      if (sa == null) return 1;
      if (sb == null) return -1;
      if (sb !== sa) return sb - sa;
      return String(a.decisionId ?? "").localeCompare(String(b.decisionId ?? ""));
    });
  } else if (sortKey === "score-asc") {
    list.sort((a, b) => {
      const sa = numericDecisionScore(a);
      const sb = numericDecisionScore(b);
      if (sa == null && sb == null) return String(a.decisionId ?? "").localeCompare(String(b.decisionId ?? ""));
      if (sa == null) return 1;
      if (sb == null) return -1;
      if (sa !== sb) return sa - sb;
      return String(a.decisionId ?? "").localeCompare(String(b.decisionId ?? ""));
    });
  }
  return list;
}

function cycleRecruiterDecisionsScoreSort() {
  if (recruiterDecisionsSortMode === "") recruiterDecisionsSortMode = "score-desc";
  else if (recruiterDecisionsSortMode === "score-desc") recruiterDecisionsSortMode = "score-asc";
  else recruiterDecisionsSortMode = "";
  renderRecruiterDecisionsTable();
}

function updateDecisionsScoreSortIndicator() {
  const span = el("decisionsScoreSortIndicator");
  const btn = el("btnSortDecisionsByScore");
  if (span) {
    span.textContent =
      recruiterDecisionsSortMode === "score-desc" ? "↓" : recruiterDecisionsSortMode === "score-asc" ? "↑" : "";
  }
  if (btn) {
    btn.setAttribute(
      "aria-sort",
      recruiterDecisionsSortMode === "score-desc"
        ? "descending"
        : recruiterDecisionsSortMode === "score-asc"
          ? "ascending"
          : "none"
    );
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
  all.textContent = "All models";
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
  const head = el("recruiterDecisionsColumnHead");
  if (!body) return;
  const sel = el("decisionsAlgoFilter");
  const filterAlgo = sel && sel.value ? sel.value : "";
  const sortKey = recruiterDecisionsSortMode || "";
  const filtered = filterAlgo
    ? recruiterDecisionsRows.filter((r) => String(r.modelName || "") === filterAlgo)
    : recruiterDecisionsRows;
  const rows = sortDecisionSnapshotRows(filtered, sortKey);

  if (meta) {
    meta.textContent =
      filterAlgo && filtered.length === 0
        ? "0 / filter"
        : `${filtered.length}/40`;
  }

  if (!recruiterDecisionsRows.length) {
    if (head) head.classList.add("d-none");
    body.innerHTML = twDecisionsEmptyLine("No snapshot rows in DB.");
    updateDecisionsScoreSortIndicator();
    return;
  }
  if (!filtered.length) {
    if (head) head.classList.add("d-none");
    body.innerHTML = twDecisionsEmptyLine("Nothing for this model.");
    updateDecisionsScoreSortIndicator();
    return;
  }
  if (head) head.classList.remove("d-none");
  body.innerHTML = rows.map((r) => twDecisionDashboardCard(r)).join("");
  updateDecisionsScoreSortIndicator();
}

async function loadRecruiterDecisions() {
  const body = el("recruiterDecisionsTableBody");
  const meta = el("recruiterDecisionsHeaderMeta");
  if (meta) meta.textContent = "Loading…";
  if (!body) return;
  try {
    const rows = await fetchData("/api/recruiter/decision-snapshot");
    recruiterDecisionsRows = Array.isArray(rows) ? rows : [];
    recruiterDecisionsSortMode = "";
    populateDecisionsAlgoFilter(recruiterDecisionsRows);
    renderRecruiterDecisionsTable();
    recruiterDecisionsLoaded = true;
  } catch (e) {
    console.error("decision snapshot:", e);
    recruiterDecisionsRows = [];
    recruiterDecisionsSortMode = "";
    const head = el("recruiterDecisionsColumnHead");
    if (head) head.classList.add("d-none");
    body.innerHTML = twDecisionsEmptyLine("Could not load snapshot.");
    updateDecisionsScoreSortIndicator();
  }
}

function initDecisionsAlgoFilter() {
  const sel = el("decisionsAlgoFilter");
  if (sel && sel.dataset.bound !== "1") {
    sel.dataset.bound = "1";
    sel.addEventListener("change", () => renderRecruiterDecisionsTable());
  }
  const scoreBtn = el("btnSortDecisionsByScore");
  if (scoreBtn && scoreBtn.dataset.bound !== "1") {
    scoreBtn.dataset.bound = "1";
    scoreBtn.addEventListener("click", () => cycleRecruiterDecisionsScoreSort());
  }
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
      transparencyFeedLoaded = true;
      return;
    }
    for (const r of rows) {
      const li = document.createElement("li");
      li.className = "mb-2 border-bottom pb-2";
      li.innerHTML = `<strong>Request #${r.requestId}</strong> — ${escapeHtml(r.requestStatus || "—")} <span class="text-secondary">· ${escapeHtml(r.detail || "")}</span>`;
      ul.appendChild(li);
    }
    transparencyFeedLoaded = true;
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
    const top = (Array.isArray(rows) ? rows : []).slice(0, 5);
    if (!top.length) {
      ol.innerHTML = `<p class="tw-mb-0 tw-text-[11px] tw-text-zinc-500">No seekers to rank.</p>`;
      decisionsRankPreviewLoaded = true;
      return;
    }
    ol.innerHTML = top
      .map((r) => {
        const fit = Number(r.aiFit || 0);
        const bar = twDecisionMatchBar(fit, { compact: true });
        return `<div class="tw-flex tw-items-center tw-gap-2 tw-rounded tw-bg-white tw-px-1.5 tw-py-0.5 tw-ring-1 tw-ring-zinc-200/70">
          <span class="tw-min-w-0 tw-flex-1 tw-truncate tw-text-[11px] tw-text-zinc-800">${escapeHtml(r.candidateName || "?")}</span>
          ${bar}
        </div>`;
      })
      .join("");
    decisionsRankPreviewLoaded = true;
  } catch (e) {
    console.error("rank preview:", e);
    ol.innerHTML = `<p class="tw-mb-0 tw-text-[11px] tw-text-red-600">Preview failed.</p>`;
  }
}

function renderFairnessCohortTable(rows, parityThreshold) {
  const tbl = el("fairnessCohortTableBody");
  if (!tbl) return;
  tbl.replaceChildren();
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td colspan="4" class="text-secondary small">No cohort rows to display.</td>';
    tbl.appendChild(tr);
    return;
  }
  for (const r of rows) {
    const rate = Number(r.selectionRate ?? 0);
    const tr = document.createElement("tr");
    if (rate < parityThreshold) tr.classList.add("table-warning");
    tr.innerHTML = `
      <td>${escapeHtml(String(r.group ?? "—"))}</td>
      <td class="text-end font-monospace">${escapeHtml(String(r.selectedCount ?? 0))}</td>
      <td class="text-end font-monospace">${escapeHtml(String(r.totalCount ?? 0))}</td>
      <td class="text-end font-monospace">${rate.toFixed(4)}</td>`;
    tbl.appendChild(tr);
  }
}

/** Normalize GET /api/fairness/summary (camelCase default; tolerate PascalCase). */
function pickFairnessSummary(data) {
  if (!data || typeof data !== "object") {
    return {
      cohortParity: [],
      demographicBreakdown: { byDepartment: [], byJobTitle: [] },
      demographicMaxGap: null,
      flaggedGroups: 0,
      minSelectionRate: 0,
    };
  }
  const cohort = data.cohortParity ?? data.CohortParity ?? [];
  const demo = data.demographicBreakdown ?? data.DemographicBreakdown ?? {};
  const byDept = demo.byDepartment ?? demo.ByDepartment ?? [];
  const byJob = demo.byJobTitle ?? demo.ByJobTitle ?? [];
  return {
    cohortParity: Array.isArray(cohort) ? cohort : [],
    demographicBreakdown: {
      byDepartment: Array.isArray(byDept) ? byDept : [],
      byJobTitle: Array.isArray(byJob) ? byJob : [],
    },
    demographicMaxGap: data.demographicMaxGap ?? data.DemographicMaxGap ?? null,
    flaggedGroups: data.flaggedGroups ?? data.FlaggedGroups ?? 0,
    minSelectionRate: data.minSelectionRate ?? data.MinSelectionRate ?? 0,
  };
}

function renderFairnessDemoTable(bodyId, rows, parityThreshold) {
  const tbl = el(bodyId);
  if (!tbl) return;
  tbl.replaceChildren();
  if (!Array.isArray(rows) || !rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td colspan="4" class="text-secondary small">No rows (missing department/title data or no impact ratios).</td>';
    tbl.appendChild(tr);
    return;
  }
  for (const r of rows) {
    const rate = Number(r.selectionRate ?? 0);
    const tr = document.createElement("tr");
    if (rate < parityThreshold) tr.classList.add("table-warning");
    tr.innerHTML = `
      <td class="text-break">${escapeHtml(String(r.group ?? "—"))}</td>
      <td class="text-end font-monospace">${escapeHtml(String(r.selectedCount ?? 0))}</td>
      <td class="text-end font-monospace">${escapeHtml(String(r.totalCount ?? 0))}</td>
      <td class="text-end font-monospace">${rate.toFixed(4)}</td>`;
    tbl.appendChild(tr);
  }
}

async function loadFairnessConsole() {
  const body = el("fairnessParityBody");
  const note = el("fairnessSummaryNote");
  const badgeWrap = el("fairnessBiasBadgeWrap");
  if (!body) return;
  const isAdminFairness = getSession()?.role === "admin";
  const parityThreshold = 0.8;
  const setBadgeHidden = (hidden) => {
    if (!badgeWrap) return;
    badgeWrap.classList.toggle("tw-hidden", hidden);
    if (hidden) badgeWrap.innerHTML = "";
  };
  try {
    const data = await fetchData("/api/fairness/summary");
    const fs = pickFairnessSummary(data);
    const rows = fs.cohortParity;
    if (!rows.length) {
      body.innerHTML = twFairnessEmptyMessage(
        "No fairness ratios available yet. Generate decision activity first."
      );
      renderFairnessCohortTable([], parityThreshold);
      if (isAdminFairness) {
        renderFairnessDemoTable("fairnessDeptTableBody", [], parityThreshold);
        renderFairnessDemoTable("fairnessJobTableBody", [], parityThreshold);
        const gapEl = el("fairnessDemographicGapNote");
        if (gapEl) gapEl.textContent = "";
      }
      if (note) note.textContent = "No fairness baseline available yet.";
      setBadgeHidden(true);
      return;
    }
    body.innerHTML = rows.map((r) => twFairnessCohortCard(r, parityThreshold)).join("");
    renderFairnessCohortTable(rows, parityThreshold);
    if (isAdminFairness) {
      const demo = fs.demographicBreakdown;
      renderFairnessDemoTable("fairnessDeptTableBody", demo.byDepartment, parityThreshold);
      renderFairnessDemoTable("fairnessJobTableBody", demo.byJobTitle, parityThreshold);
      const gapNote = el("fairnessDemographicGapNote");
      if (gapNote) {
        const g = fs.demographicMaxGap;
        if (g != null && Number.isFinite(Number(g))) {
          gapNote.innerHTML = `<strong>Spread between buckets</strong> (dept + title): max − min selection rate = <strong>${Number(g).toFixed(4)}</strong> — larger gaps warrant investigation.`;
        } else {
          gapNote.textContent = "";
        }
      }
    }
    const flagged = rows.filter((r) => Number(r.selectionRate ?? 0) < parityThreshold).length;
    const fg = Number(fs.flaggedGroups ?? 0);
    if (badgeWrap) {
      setBadgeHidden(false);
      if (flagged > 0) {
        badgeWrap.innerHTML = `<span class="tw-inline-flex tw-items-center tw-gap-1.5 tw-rounded-full tw-bg-red-600 tw-px-3 tw-py-1 tw-text-xs tw-font-bold tw-tracking-wide tw-text-white tw-shadow-md tw-animate-pulse" role="status">Bias Alert · ${flagged} cohort(s) below ${parityThreshold}</span>`;
      } else {
        badgeWrap.innerHTML = `<span class="tw-inline-flex tw-items-center tw-rounded-full tw-bg-emerald-100 tw-px-3 tw-py-1 tw-text-xs tw-font-semibold tw-text-emerald-900">Parity OK</span>`;
      }
    }
    if (note) {
      const minRate = Number(fs.minSelectionRate ?? 0);
      note.textContent =
        flagged > 0
          ? `${flagged} cohort(s) under ${parityThreshold.toFixed(2)} selection-rate parity (${fg} flagged in API summary). Lowest cohort rate ${minRate.toFixed(4)}.`
          : `All cohorts at or above ${parityThreshold.toFixed(2)} rate. Lowest cohort rate ${minRate.toFixed(4)}.`;
    }
  } catch (e) {
    console.error("fairness summary:", e);
    body.innerHTML = twFairnessEmptyMessage("Could not load fairness summary.");
    const tbl = el("fairnessCohortTableBody");
    if (tbl) {
      tbl.replaceChildren();
      const tr = document.createElement("tr");
      tr.innerHTML =
        '<td colspan="4" class="text-secondary small">Could not load cohort table.</td>';
      tbl.appendChild(tr);
    }
    if (isAdminFairness) {
      renderFairnessDemoTable("fairnessDeptTableBody", [], 0.8);
      renderFairnessDemoTable("fairnessJobTableBody", [], 0.8);
      const gapEl = el("fairnessDemographicGapNote");
      if (gapEl) gapEl.textContent = "";
    }
    if (note) note.textContent = "Could not load fairness summary.";
    setBadgeHidden(true);
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
      if (
        (s.role === "recruiter" || s.role === "admin" || s.role === "auditor") &&
        !decisionsContextLoaded
      ) {
        void loadDecisionsContextPanels();
      }
    });
  }
  const fairnessTab = el("tab-fairness");
  if (fairnessTab && fairnessTab.dataset.lazyBound !== "1") {
    fairnessTab.dataset.lazyBound = "1";
    fairnessTab.addEventListener("shown.bs.tab", () => {
      const s = getSession();
      if (s?.role === "recruiter" || s?.role === "auditor" || s?.role === "admin") {
        void loadFairnessConsole();
      }
    });
  }
}

async function loadDecisionsContextPanels() {
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
    const algList = Array.isArray(algorithms) ? algorithms : [];
    if (!algList.length) {
      algoBody.innerHTML = twFairnessEmptyMessage("No algorithms on file.");
    } else {
      algoBody.innerHTML = [...algList]
        .sort((x, y) => (x.algoId ?? 0) - (y.algoId ?? 0))
        .map((a) => twAlgorithmLibraryCard(a))
        .join("");
    }

    const crList = Array.isArray(criteria) ? criteria : [];
    if (!crList.length) {
      policyBody.innerHTML = twFairnessEmptyMessage("No policy rules on file.");
    } else {
      policyBody.innerHTML = [...crList]
        .sort((x, y) => (x.criteriaId ?? 0) - (y.criteriaId ?? 0))
        .map((c) => twPolicyGuideCard(c))
        .join("");
    }

    if (modelCmpBody) {
      const comp = Array.isArray(comparison) ? comparison : [];
      if (!comp.length) {
        modelCmpBody.innerHTML = twFairnessEmptyMessage("No decision factors loaded for comparison.");
      } else {
        const sorted = [...comp].sort((a, b) => Number(b.avgImpact || 0) - Number(a.avgImpact || 0));
        const nums = [];
        for (const row of sorted) {
          nums.push(Number(row.avgImpact ?? 0), Number(row.minImpact ?? 0), Number(row.maxImpact ?? 0));
        }
        const lo = Math.min(...nums);
        const hi = Math.max(...nums);
        modelCmpBody.innerHTML = sorted.map((row) => twModelComparisonCard(row, lo, hi)).join("");
      }
    }

    decisionsContextLoaded = true;
  } catch (e) {
    console.error("decisions context panels:", e);
    algoBody.innerHTML = twFairnessEmptyMessage("Could not load algorithms.");
    policyBody.innerHTML = twFairnessEmptyMessage("Could not load policy rules.");
    if (modelCmpBody) {
      modelCmpBody.innerHTML = twFairnessEmptyMessage("Could not load model comparison.");
    }
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

function readAuditFilterUi() {
  return {
    search: (el("auditSearchInput")?.value || "").trim().toLowerCase(),
    compliance: el("auditFilterCompliance")?.value || "all",
    eventType: el("auditFilterEventType")?.value || "all",
    impact: el("auditFilterImpact")?.value || "all",
    userId: (el("auditFilterUserId")?.value || "").trim(),
    reviewerId: (el("auditFilterReviewerId")?.value || "").trim(),
    factorId: (el("auditFilterFactorId")?.value || "").trim(),
  };
}

function matchesEventTypeFilter(e, eventType) {
  if (eventType === "all") return true;
  if (eventType === "match") return e.type === "job_match";
  if (eventType === "rank") return e.type === "candidate_rank" || e.type === "audit_view";
  if (eventType === "review") return e.type === "human_review";
  return true;
}

function matchesImpactFilter(e, impact) {
  if (impact === "all") return true;
  const r = e.impactRatio;
  if (impact === "none") return r == null || Number.isNaN(r);
  if (impact === "risk_low") return r != null && !Number.isNaN(r) && r < 0.7;
  if (impact === "ok") return r != null && !Number.isNaN(r) && r >= 0.7;
  return true;
}

function idTokenMatches(rowVal, filterText) {
  if (!filterText) return true;
  if (rowVal == null || rowVal === "") return false;
  return String(rowVal).includes(filterText);
}

function renderAuditTable() {
  const body = el("auditTableBody");
  const countLabel = el("auditCount");
  if (!body || !countLabel) return;

  const f = readAuditFilterUi();

  const rows = auditLogRows.filter((e) => {
    if (!matchesEventTypeFilter(e, f.eventType)) return false;
    if (!matchesImpactFilter(e, f.impact)) return false;

    if (f.compliance === "non_compliant" && e.compliance !== "non_compliant") return false;
    if (f.compliance === "compliant" && e.compliance !== "compliant") return false;
    if (f.compliance === "unsure" && e.compliance !== "unsure") return false;

    if (!idTokenMatches(e.userId, f.userId)) return false;
    if (!idTokenMatches(e.reviewerId, f.reviewerId)) return false;
    if (!idTokenMatches(e.factorId, f.factorId)) return false;

    if (f.search) {
      const hay = [
        e.time,
        e.subject,
        e.policy,
        e.outcome,
        e.logId != null ? String(e.logId) : "",
        formatType(e.type),
        e.compliance,
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(f.search)) return false;
    }

    return true;
  });

  const total = auditLogRows.length;
  countLabel.textContent =
    rows.length === total || total === 0
      ? `${rows.length} events`
      : `${rows.length} shown (${total} loaded)`;

  body.replaceChildren();

  if (rows.length === 0 && total > 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" class="text-secondary small">
      No rows match your filters, but <strong>${total}</strong> event(s) are loaded.
      Click <strong>Clear filters</strong> or set Impact to <strong>All</strong> (many rows have no impact ratio).
    </td>`;
    body.appendChild(tr);
    return;
  }

  if (rows.length === 0 && total === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" class="text-secondary small">
      No audit events returned. If the API is unreachable, check the browser console and that the server is running.
    </td>`;
    body.appendChild(tr);
    return;
  }

  for (const e of rows) {
    const tr = document.createElement("tr");
    if (e.compliance === "non_compliant") {
      tr.classList.add("table-danger");
    }
    tr.innerHTML = `
      <td><time datetime="${escapeHtml(e.time)}">${escapeHtml(e.time)}</time></td>
      <td>${complianceBadgeHtml(e.compliance)}</td>
      <td>${formatType(e.type)}</td>
      <td>${escapeHtml(e.subject)}</td>
      <td>${escapeHtml(e.policy)}</td>
      <td class="text-end font-monospace">${escapeHtml(e.outcome)}</td>
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

/** Decisions tab: match bar — green &gt;0.9, yellow &gt;0.7, red otherwise (≤0.7). */
function twDecisionMatchBar(score, opts = {}) {
  const compact = Boolean(opts.compact);
  const snapshot = Boolean(opts.snapshot);
  const s = Number(score);
  if (!Number.isFinite(s)) {
    if (snapshot) {
      return `<div class="tw-flex tw-w-full tw-min-w-0 tw-items-center tw-gap-2">
        <div class="tw-min-w-0 tw-flex-1 tw-h-2.5 tw-overflow-hidden tw-rounded-full tw-bg-zinc-200/90" aria-hidden="true"></div>
        <span class="tw-shrink-0 tw-text-sm tw-font-bold tw-tabular-nums tw-text-zinc-400">—</span>
      </div>`;
    }
    return '<span class="tw-text-xs tw-text-zinc-400">—</span>';
  }
  const pct = Math.min(100, Math.max(0, Math.round(s * 100)));
  let bar = "tw-bg-red-500";
  if (s > 0.9) bar = "tw-bg-green-500";
  else if (s > 0.7) bar = "tw-bg-yellow-400";
  const h = compact && !snapshot ? "tw-h-1.5" : "tw-h-2.5";
  const scoreCls = snapshot
    ? "tw-shrink-0 tw-text-sm tw-font-bold tw-tabular-nums tw-text-zinc-800"
    : "tw-shrink-0 tw-text-xs tw-font-bold tw-tabular-nums tw-text-zinc-800";
  const inner = `<div class="tw-min-w-0 tw-flex-1 ${h} tw-overflow-hidden tw-rounded-full tw-bg-zinc-200/90">
      <div class="${bar} tw-h-full tw-rounded-full tw-transition-[width]" style="width:${pct}%"></div>
    </div>
    <span class="${scoreCls}">${s.toFixed(2)}</span>`;
  if (compact) {
    const wrapCls = snapshot
      ? "tw-flex tw-w-full tw-min-w-0 tw-items-center tw-gap-2"
      : "tw-flex tw-w-[6.5rem] tw-shrink-0 tw-items-center tw-gap-1.5 sm:tw-w-[7.5rem]";
    return `<div class="${wrapCls}">${inner}</div>`;
  }
  return `<div class="tw-mt-2 tw-flex tw-min-w-0 tw-items-center tw-gap-3">
    <span class="tw-shrink-0 tw-text-[10px] tw-font-semibold tw-uppercase tw-tracking-wide tw-text-zinc-400">Match</span>
    ${inner}
  </div>`;
}

function splitDecisionSubjectLabel(subject) {
  const s = String(subject ?? "").trim();
  const sep = " · ";
  const i = s.indexOf(sep);
  if (i === -1) return { name: s, subtitle: "" };
  return { name: s.slice(0, i).trim(), subtitle: s.slice(i + sep.length).trim() };
}

function twDecisionDashboardCard(row) {
  const sc = row.score != null && row.score !== "" ? Number(row.score) : NaN;
  const bar = twDecisionMatchBar(sc, { compact: true, snapshot: true });
  const decisionId = row.decisionId != null ? String(row.decisionId) : "—";
  const type = row.type != null ? String(row.type) : "—";
  const subject = row.subject != null ? String(row.subject) : "—";
  const policy = row.policy != null ? String(row.policy) : "—";
  const tip = `${type} · Policy: ${policy}`;
  const { name, subtitle } = splitDecisionSubjectLabel(subject);
  const nameBlock =
    subtitle.length > 0
      ? `<div class="tw-flex tw-min-w-0 tw-flex-wrap tw-items-baseline tw-gap-x-1">
          <span class="tw-truncate tw-text-sm tw-font-semibold tw-text-zinc-900 sm:tw-text-base">${escapeHtml(name)}</span>
          <span class="tw-shrink-0 tw-text-xs tw-font-medium tw-text-zinc-500 sm:tw-text-sm">· ${escapeHtml(subtitle)}</span>
        </div>`
      : `<div class="tw-min-w-0"><span class="tw-block tw-truncate tw-text-sm tw-font-semibold tw-text-zinc-900 sm:tw-text-base">${escapeHtml(name)}</span></div>`;
  return `<div class="tw-grid tw-grid-cols-[9rem_minmax(0,1fr)_7.5rem] tw-items-center tw-gap-x-3 tw-rounded tw-border tw-border-zinc-200/50 tw-bg-white tw-px-3 tw-py-1.5 hover:tw-border-zinc-300 sm:tw-grid-cols-[10rem_minmax(0,1fr)_8rem]" title="${escapeHtml(tip)}">
    <code class="tw-min-w-0 tw-truncate tw-font-mono tw-text-xs tw-leading-snug tw-text-zinc-500 sm:tw-text-[13px]">${escapeHtml(decisionId)}</code>
    <div class="tw-min-w-0">${nameBlock}</div>
    <div class="tw-flex tw-min-w-0 tw-w-full tw-items-center tw-justify-end">${bar}</div>
  </div>`;
}

function twImpactHeatStyle(val, lo, hi) {
  const v = Number(val);
  const t = hi === lo ? 0.5 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  const hue = 25 + t * 105;
  return `background:linear-gradient(145deg,hsla(${hue},72%,95%,1),hsla(${hue - 8},58%,88%,1));border-color:hsla(${hue - 15},40%,76%,0.9)`;
}

function twModelRangeStrip(lo, hi, minV, avgV, maxV) {
  const span = hi - lo || 1;
  const p = (x) => Math.max(0, Math.min(100, ((Number(x) - lo) / span) * 100));
  const pm = p(minV);
  const pa = p(avgV);
  const px = p(maxV);
  return `<div class="tw-relative tw-mt-3 tw-h-2.5 tw-overflow-hidden tw-rounded-full tw-border tw-border-zinc-200/80">
    <div class="tw-absolute tw-inset-0 tw-bg-gradient-to-r tw-from-rose-200 tw-via-amber-200 tw-to-emerald-300"></div>
    <div class="tw-absolute tw-bottom-0 tw-top-0 tw-w-0.5 tw-bg-zinc-800/70" style="left:${pm}%" title="Min"></div>
    <div class="tw-absolute tw-bottom-0 tw-top-0 tw-w-0.5 tw-bg-zinc-900" style="left:${pa}%" title="Avg"></div>
    <div class="tw-absolute tw-bottom-0 tw-top-0 tw-w-0.5 tw-bg-zinc-800/70" style="left:${px}%" title="Max"></div>
  </div>
  <div class="tw-mt-1 tw-flex tw-justify-between tw-text-[10px] tw-font-medium tw-text-zinc-500">
    <span>min ${Number(minV).toFixed(2)}</span><span>avg ${Number(avgV).toFixed(2)}</span><span>max ${Number(maxV).toFixed(2)}</span>
  </div>`;
}

function twFairnessCohortCard(r, parityThreshold) {
  const selected = Number(r.selectedCount ?? 0);
  const total = Number(r.totalCount ?? 0);
  const rate = Number(r.selectionRate ?? 0);
  const bias = rate < parityThreshold;
  const selPct = total > 0 ? Math.round((selected / total) * 100) : 0;
  return `<article class="tw-relative tw-overflow-hidden tw-rounded-2xl tw-border tw-p-4 tw-shadow-sm ${
    bias
      ? "tw-border-red-300 tw-bg-gradient-to-br tw-from-red-50 tw-to-white"
      : "tw-border-emerald-200 tw-bg-gradient-to-br tw-from-emerald-50/90 tw-to-white"
  }">
    ${
      bias
        ? '<div class="tw-absolute tw-right-3 tw-top-3 tw-rounded-full tw-bg-red-600 tw-px-2 tw-py-0.5 tw-text-[10px] tw-font-bold tw-tracking-wide tw-text-white tw-shadow-sm tw-animate-pulse">BIAS ALERT</div>'
        : ""
    }
    <h3 class="tw-mb-1 tw-pr-24 tw-text-sm tw-font-bold tw-text-zinc-900">${escapeHtml(r.group || "Unknown")}</h3>
    <p class="tw-mb-2 tw-text-xs tw-text-zinc-500">${escapeHtml(String(selected))} / ${escapeHtml(String(total))} selected (${escapeHtml(String(selPct))}%)</p>
    <p class="tw-mb-0 tw-text-3xl tw-font-black tw-tabular-nums ${bias ? "tw-text-red-600" : "tw-text-emerald-700"}">${escapeHtml(rate.toFixed(2))}</p>
    <p class="tw-mb-0 tw-mt-1 tw-text-[11px] tw-font-medium tw-text-zinc-500">Selection rate</p>
  </article>`;
}

function twFairnessEmptyMessage(msg) {
  return `<p class="tw-col-span-full tw-mb-0 tw-rounded-lg tw-border tw-border-dashed tw-border-zinc-200 tw-bg-zinc-50 tw-p-4 tw-text-sm tw-text-zinc-500">${escapeHtml(msg)}</p>`;
}

function twDecisionsEmptyLine(msg) {
  return `<p class="tw-mb-0 tw-py-1 tw-text-xs tw-text-zinc-500">${escapeHtml(msg)}</p>`;
}

function twAlgorithmLibraryCard(a) {
  const dt = a.lastAuditDate != null ? String(a.lastAuditDate).slice(0, 10) : "—";
  return `<article class="tw-flex tw-h-full tw-flex-col tw-rounded-xl tw-border tw-border-zinc-200 tw-bg-white tw-p-4 tw-shadow-sm">
    <h3 class="tw-mb-1 tw-text-sm tw-font-bold tw-text-zinc-900">${escapeHtml(a.modelName || "—")}</h3>
    <p class="tw-mb-3 tw-text-xs tw-text-zinc-500">${escapeHtml(a.vendor || "—")} · v${escapeHtml(a.version || "—")}</p>
    <p class="tw-mt-auto tw-mb-0 tw-text-xs tw-font-medium tw-text-zinc-600">Last audit <span class="tw-tabular-nums tw-text-zinc-800">${escapeHtml(dt)}</span></p>
  </article>`;
}

function twPolicyGuideCard(c) {
  const minY = c.minExperience != null ? String(c.minExperience) : "—";
  return `<article class="tw-rounded-xl tw-border tw-border-zinc-200 tw-bg-white tw-p-4 tw-shadow-sm">
    <h3 class="tw-mb-2 tw-text-sm tw-font-bold tw-text-zinc-900">${escapeHtml(c.jobTitle || "—")}</h3>
    <p class="tw-mb-2 tw-text-xs tw-leading-relaxed tw-text-zinc-600">${escapeHtml(c.requiredSkills || "—")}</p>
    <p class="tw-mb-0 tw-text-xs tw-font-semibold tw-text-teal-800">Min experience: <span class="tw-tabular-nums">${escapeHtml(minY)}</span> yrs</p>
  </article>`;
}

function twModelComparisonCard(row, lo, hi) {
  const avg = Number(row.avgImpact ?? 0);
  const mn = Number(row.minImpact ?? 0);
  const mx = Number(row.maxImpact ?? 0);
  const strip = twModelRangeStrip(lo, hi, mn, avg, mx);
  return `<article class="tw-flex tw-h-full tw-flex-col tw-rounded-2xl tw-border tw-border-zinc-200 tw-bg-white tw-p-4 tw-shadow-md">
    <div class="tw-mb-2 tw-flex tw-items-start tw-justify-between tw-gap-2">
      <h3 class="tw-mb-0 tw-text-base tw-font-bold tw-leading-tight tw-text-zinc-900">${escapeHtml(row.modelName || "—")}</h3>
      <span class="tw-shrink-0 tw-rounded-md tw-bg-zinc-100 tw-px-2 tw-py-0.5 tw-font-mono tw-text-[11px] tw-text-zinc-600">#${escapeHtml(String(row.algoId ?? "?"))}</span>
    </div>
    <p class="tw-mb-3 tw-text-xs tw-text-zinc-600">${escapeHtml(String(row.factorCount ?? "—"))} decision factors in snapshot</p>
    <div class="tw-grid tw-grid-cols-3 tw-gap-2 tw-text-center">
      <div class="tw-rounded-lg tw-border tw-border-white/60 tw-bg-white/50 tw-p-2 tw-shadow-sm" style="${twImpactHeatStyle(avg, lo, hi)}">
        <div class="tw-text-[10px] tw-font-bold tw-uppercase tw-tracking-wider tw-text-zinc-500">Avg</div>
        <div class="tw-text-lg tw-font-black tw-tabular-nums tw-text-zinc-900">${avg.toFixed(2)}</div>
      </div>
      <div class="tw-rounded-lg tw-border tw-border-white/60 tw-bg-white/50 tw-p-2 tw-shadow-sm" style="${twImpactHeatStyle(mn, lo, hi)}">
        <div class="tw-text-[10px] tw-font-bold tw-uppercase tw-tracking-wider tw-text-zinc-500">Min</div>
        <div class="tw-text-lg tw-font-black tw-tabular-nums tw-text-zinc-900">${mn.toFixed(2)}</div>
      </div>
      <div class="tw-rounded-lg tw-border tw-border-white/60 tw-bg-white/50 tw-p-2 tw-shadow-sm" style="${twImpactHeatStyle(mx, lo, hi)}">
        <div class="tw-text-[10px] tw-font-bold tw-uppercase tw-tracking-wider tw-text-zinc-500">Max</div>
        <div class="tw-text-lg tw-font-black tw-tabular-nums tw-text-zinc-900">${mx.toFixed(2)}</div>
      </div>
    </div>
    ${strip}
  </article>`;
}

/** AI match 0–1: same tiers as factor bars (>0.9 green, >0.7 yellow, else red). */
function scoreBadgeClass(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return "text-bg-secondary";
  if (s > 0.9) return "text-bg-success";
  if (s > 0.7) return "text-bg-warning text-dark";
  return "text-bg-danger";
}

function matchScoreBarClass(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return "bg-secondary";
  if (s > 0.9) return "bg-success";
  if (s > 0.7) return "bg-warning";
  return "bg-danger";
}

/** Inline bar + numeric (Bootstrap equivalent of Tailwind flex + rounded-full track). */
function renderMatchScoreBarCell(score, opts = {}) {
  const align = opts.align === "start" ? "justify-content-start" : "justify-content-end";
  const s = Number(score ?? 0);
  const pct = Math.min(100, Math.max(0, Math.round(s * 100)));
  const bar = matchScoreBarClass(s);
  return `<div class="d-flex align-items-center gap-2 w-100 ${align}">
    <div class="progress flex-grow-1" style="max-width: 14rem; height: 10px" role="none">
      <div class="progress-bar ${bar}" style="width: ${pct}%" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"></div>
    </div>
    <span class="small fw-semibold text-nowrap">${Number.isFinite(s) ? s.toFixed(2) : "—"}</span>
  </div>`;
}

function renderAlgorithmBreakdownHtml(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) {
    return '<p class="text-secondary small mb-0">No per-algorithm factor rows (link <code>user_decision_factors</code> to factors).</p>';
  }
  const esc = (s) => escapeHtml(String(s ?? ""));
  return blocks
    .map((block) => {
      const factors = Array.isArray(block.factors) ? block.factors : [];
      const fnRows = factors
        .map((f) => {
          const nm = (f.factorName && String(f.factorName).trim()) || `Factor ${f.factorId}`;
          const cm = Number(f.candidateMatchScore ?? 0);
          const rw = f.rubricWeight != null && f.rubricWeight !== "" ? Number(f.rubricWeight) : null;
          const ev = f.evidenceNotes ? String(f.evidenceNotes).trim() : "";
          const rwTxt = rw != null && Number.isFinite(rw) ? rw.toFixed(2) : "—";
          return `<tr>
            <td class="small px-2 py-2">${esc(nm)}</td>
            <td class="small px-2 py-2">${renderMatchScoreBarCell(cm)}</td>
            <td class="text-end small text-muted px-2 py-2">${rwTxt}</td>
            <td class="small text-muted px-2 py-2">${ev ? esc(ev) : "—"}</td>
          </tr>`;
        })
        .join("");
      const note = block.explainer ? `<p class="small text-muted mb-2">${esc(block.explainer)}</p>` : "";
      return `<div class="mb-3 pb-3 border-bottom border-secondary-subtle">
        <p class="small fw-semibold mb-1">${esc(block.modelName || "Model")} <span class="text-muted">(algo ${esc(block.algoId)})</span></p>
        ${note}
        <div class="table-responsive">
          <table class="table table-sm table-bordered mb-0">
            <thead class="table-light"><tr>
              <th scope="col">Factor</th>
              <th scope="col" style="min-width: 11rem">Candidate match</th>
              <th scope="col" class="text-end">Rubric weight</th>
              <th scope="col">Evidence / inputs</th>
            </tr></thead>
            <tbody>${fnRows}</tbody>
          </table>
        </div>
      </div>`;
    })
    .join("");
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

    const detailTr = document.createElement("tr");
    detailTr.className = "table-light";
    const summaryText = row.fitSummary ? escapeHtml(String(row.fitSummary)) : "Open for model vs. factor detail.";
    detailTr.innerHTML = `<td colspan="7" class="py-2 small">
      <details class="ranked-talent-detail">
        <summary class="fw-semibold user-select-none">${summaryText}</summary>
        <div class="pt-2">${renderAlgorithmBreakdownHtml(row.algorithmBreakdown)}</div>
      </details>
    </td>`;
    body.appendChild(detailTr);
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
      const rw = f.rubricWeight != null && f.rubricWeight !== "" ? Number(f.rubricWeight) : null;
      const rwLine =
        rw != null && Number.isFinite(rw)
          ? `<div class="small mb-1"><span class="fw-semibold text-secondary">Rubric weight in model:</span> <span class="text-muted">${rw.toFixed(2)}</span> <span class="text-muted">(how much this factor loads in the composite)</span></div>`
          : "";
      const ev = f.evidenceNotes != null && String(f.evidenceNotes).trim();
      const evLine = ev
        ? `<div class="small mb-1"><span class="fw-semibold text-secondary">Evidence / inputs:</span> <span class="text-muted">${escapeHtml(String(f.evidenceNotes).trim())}</span></div>`
        : `<div class="small text-muted mb-1"><span class="fw-semibold text-secondary">Evidence / inputs:</span> — <span class="text-muted">(populate <code>user_decision_factors.evidence_notes</code> for résumé-aligned narrative)</span></div>`;
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
          : `<div class="small text-muted mb-1"><span class="fw-semibold text-secondary">Required benchmark:</span> — <span class="text-muted">(no scoring row linked for this model — run policy seed / link <code>algorithm_benchmarks</code>)</span></div>`;
      const barCls = matchScoreBarClass(score);
      return `
      <div class="mb-3">
        <div class="d-flex justify-content-between small mb-1">
          <span><strong>${escapeHtml(fname)}</strong> <span class="text-muted">(${escapeHtml(model)}${jobHint})</span></span>
        </div>
        ${rwLine}
        ${evLine}
        ${benchLine}
        <div class="d-flex align-items-center gap-2 px-1">
          <div class="progress flex-grow-1" style="height: 10px" role="none">
            <div class="progress-bar ${barCls}" style="width: ${pct}%" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" title="Match ${score.toFixed(2)}"></div>
          </div>
          <span class="small fw-semibold text-nowrap" title="Candidate match on this factor">${score.toFixed(2)}</span>
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

  applyRolePreview(role);
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
  const controls = [
    "auditSearchInput",
    "auditFilterCompliance",
    "auditFilterEventType",
    "auditFilterImpact",
    "auditFilterUserId",
    "auditFilterReviewerId",
    "auditFilterFactorId",
  ];
  for (const id of controls) {
    const node = el(id);
    if (!node) continue;
    node.addEventListener("input", () => renderAuditTable());
    node.addEventListener("change", () => renderAuditTable());
  }
  const clear = el("btnAuditClearFilters");
  if (clear) {
    clear.addEventListener("click", () => {
      const s = el("auditSearchInput");
      if (s) s.value = "";
      const c = el("auditFilterCompliance");
      if (c) c.value = "all";
      const et = el("auditFilterEventType");
      if (et) et.value = "all";
      const im = el("auditFilterImpact");
      if (im) im.value = "all";
      const u = el("auditFilterUserId");
      if (u) u.value = "";
      const r = el("auditFilterReviewerId");
      if (r) r.value = "";
      const f = el("auditFilterFactorId");
      if (f) f.value = "";
      renderAuditTable();
    });
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
  if (session.role === "seeker") void loadTransparencyFeed(session.email);
  if (session.role === "recruiter" || session.role === "admin") {
    loadRankedTalent();
    loadReviewRequests();
  } else if (session.role === "auditor") {
    loadReviewRequests();
  }
  if (session.role === "auditor" || session.role === "admin") {
    void loadDirectoryFromApi();
  }
  if (session.role === "recruiter" || session.role === "auditor" || session.role === "admin") {
    void loadFairnessConsole();
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

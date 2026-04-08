/**
 * TalentFlow demo — login session, RBAC (seekers never see audit log), synthetic data.
 */

const SESSION_KEY = "talentflow_demo_session_v1";
const DEMO_PASSWORD = "demo123";

/** Role is authoritative here; session only stores verified email. */
const DEMO_USERS = [
  { email: "maya.chen@example.com", password: DEMO_PASSWORD, name: "Maya Chen", role: "seeker" },
  { email: "jordan.lee@acme.example", password: DEMO_PASSWORD, name: "Jordan Lee", role: "recruiter" },
  { email: "sam.rivera@example.com", password: DEMO_PASSWORD, name: "Sam Rivera", role: "auditor" },
  { email: "ravi.patel@example.com", password: DEMO_PASSWORD, name: "Ravi Patel", role: "admin" },
];

const AUDIT_EVENTS = [
  {
    time: "2026-04-08T15:42:18Z",
    type: "human_review",
    subject: "ticket=hr-1201 · decision=dec-20260407-88f1 · reason=incorrect",
    policy: "review SLA tier=standard",
    outcome: "Queued · pool=compliance-na",
  },
  {
    time: "2026-04-08T15:19:02Z",
    type: "audit_view",
    subject: "actor=j.lee@acme · tenant=acme · action=export_shortlist · REQ-441",
    policy: "access log v1",
    outcome: "Export token ex-9082 · 11 rows",
  },
  {
    time: "2026-04-08T14:55:41Z",
    type: "candidate_rank",
    subject: "req=REQ-441 · viewer=acme · pool=24",
    policy: "candidate-rank v2026.03 · embed text-embed-v2",
    outcome: "Ordered · top cand-91a · fit 0.91",
  },
  {
    time: "2026-04-08T14:52:10Z",
    type: "job_match",
    subject: "user=u-104 · job=j-nimbus-srbe",
    policy: "job-matching v2026.04",
    outcome: "Position 1 · score 0.91 · tpl em-geo-skills-01",
  },
  {
    time: "2026-04-08T14:31:00Z",
    type: "job_match",
    subject: "user=u-088 · job=j-harbor-platform",
    policy: "job-matching v2026.04",
    outcome: "Position 2 · score 0.85",
  },
  {
    time: "2026-04-08T14:18:40Z",
    type: "candidate_rank",
    subject: "req=REQ-388 · viewer=acme · pool=41",
    policy: "candidate-rank v2026.03",
    outcome: "Ordered · top cand-402 · fit 0.82",
  },
  {
    time: "2026-04-08T14:02:11Z",
    type: "job_match",
    subject: "user=u-104 · feed=home · session=s-9f2a",
    policy: "job-matching v2026.04 / ranker v3.2",
    outcome: "Feed built · 42 cards · diversity penalty on",
  },
  {
    time: "2026-04-08T13:47:22Z",
    type: "audit_view",
    subject: "actor=s.rivera@example · action=open_audit_log · filter=24h",
    policy: "access log v1",
    outcome: "Page view · wm-20260408-audit",
  },
  {
    time: "2026-04-08T12:10:05Z",
    type: "candidate_rank",
    subject: "req=REQ-502 · viewer=harbor · pool=19",
    policy: "candidate-rank v2026.03",
    outcome: "Re-run after policy tweak PR-188",
  },
  {
    time: "2026-04-08T11:22:33Z",
    type: "job_match",
    subject: "user=u-201 · job=j-copperbank-api",
    policy: "job-matching v2026.04",
    outcome: "Score 0.84 · geo=Remote US",
  },
  {
    time: "2026-04-08T09:14:08Z",
    type: "human_review",
    subject: "ticket=hr-008 · decision=dec-20260408-001 · flag=FLAG-9082",
    policy: "escalation tier=2",
    outcome: "Assigned · compliance analyst",
  },
  {
    time: "2026-04-08T08:01:00Z",
    type: "audit_view",
    subject: "actor=c.vance@staffright · action=view_rank_list · REQ-610",
    policy: "access log v1",
    outcome: "Watermark wm-20260408-610",
  },
  {
    time: "2026-04-07T22:18:44Z",
    type: "candidate_rank",
    subject: "req=REQ-610 · viewer=staffright · pool=33",
    policy: "candidate-rank v2026.03",
    outcome: "Agency pool rules applied",
  },
  {
    time: "2026-04-07T18:02:00Z",
    type: "job_match",
    subject: "user=u-088 · feed=home",
    policy: "job-matching v2026.04",
    outcome: "18 cards · boost none",
  },
  {
    time: "2026-04-07T16:40:00Z",
    type: "human_review",
    subject: "ticket=hr-008 · decision=dec-20260408-001",
    policy: "review SLA tier=standard",
    outcome: "Queued; pool=compliance-na",
  },
  {
    time: "2026-04-07T14:11:29Z",
    type: "audit_view",
    subject: "actor=r.patel@example · action=policy_export",
    policy: "admin audit v2",
    outcome: "Bundle pol-2026-04.zip",
  },
  {
    time: "2026-04-07T11:05:00Z",
    type: "candidate_rank",
    subject: "req=REQ-441 · viewer=acme · pool=24",
    policy: "candidate-rank v2026.03",
    outcome: "Ordered · top cand-91a",
  },
  {
    time: "2026-04-07T09:33:12Z",
    type: "job_match",
    subject: "user=u-104 · job=j-9012",
    policy: "job-matching v2026.04",
    outcome: "Shown pos 1 · explain tpl em-geo-skills-01",
  },
  {
    time: "2026-04-07T08:00:00Z",
    type: "audit_view",
    subject: "actor=system · action=drift_check · embeddings",
    policy: "monitoring v1",
    outcome: "Drift index 0.01 · OK",
  },
  {
    time: "2026-04-06T19:22:00Z",
    type: "candidate_rank",
    subject: "req=REQ-220 · viewer=acme · pool=12",
    policy: "candidate-rank v2026.03",
    outcome: "Ordered · top cand-110 · fit 0.77",
  },
  {
    time: "2026-04-06T15:00:00Z",
    type: "job_match",
    subject: "user=u-310 · job=j-northwind-data",
    policy: "job-matching v2026.04",
    outcome: "Score 0.78 · skills partial",
  },
  {
    time: "2026-04-06T10:15:00Z",
    type: "human_review",
    subject: "ticket=hr-004 · decision=dec-20260405-31c0",
    policy: "review SLA tier=standard",
    outcome: "Resolved · no change",
  },
  {
    time: "2026-04-05T23:45:00Z",
    type: "audit_view",
    subject: "actor=j.lee@acme · action=view_rank_list",
    policy: "access log v1",
    outcome: "Rank list · REQ-441",
  },
  {
    time: "2026-04-05T17:00:00Z",
    type: "job_match",
    subject: "user=u-201 · feed=search · q=backend",
    policy: "job-matching v2026.04",
    outcome: "Rerank · search blend 0.6",
  },
];

let auditFilter = "all";
let appListenersAttached = false;

const ROLE_BANNER = {
  seeker:
    "Signed in as Seeker: Job postings (ranked for you), Profile, and Explainability. No directory, fairness console, about page, or audit log.",
  recruiter:
    "Signed in as Recruiter: Ranked talent (AI), Review requests from applicants, pipeline KPIs. No directory or About. Audit log: Auditor/Admin only.",
  auditor:
    "Signed in as Auditor: Review requests, Directory, Audit log, Fairness, About. Ranked talent is recruiter-only.",
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

function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const email = typeof parsed.email === "string" ? parsed.email.trim().toLowerCase() : "";
    const user = DEMO_USERS.find((u) => u.email === email);
    if (!user) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return { email: user.email, name: user.name, role: user.role };
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function saveSession(email) {
  const normalized = email.trim().toLowerCase();
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ email: normalized }));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

function showLoginView() {
  delete document.body.dataset.talentflowRole;
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
  if (loginView) {
    loginView.classList.add("d-none");
    loginView.setAttribute("aria-hidden", "true");
  }
  if (appView) {
    appView.classList.remove("d-none");
    appView.setAttribute("aria-hidden", "false");
  }
}

function updateSessionDisplay(session) {
  const display = el("sessionUserDisplay");
  if (!display || !session) return;
  const badgeClass =
    session.role === "seeker"
      ? "text-bg-primary"
      : session.role === "recruiter"
        ? "text-bg-info text-dark"
        : session.role === "auditor"
          ? "text-bg-dark"
          : "text-bg-secondary";
  display.innerHTML =
    escapeHtml(session.name) +
    ' <span class="badge ' +
    badgeClass +
    '">' +
    escapeHtml(session.role) +
    "</span>";
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

function renderAuditTable() {
  const body = el("auditTableBody");
  const countLabel = el("auditCount");
  if (!body || !countLabel) return;

  const rows = AUDIT_EVENTS.filter((e) => {
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
      <td><time datetime="${e.time}">${e.time}</time></td>
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

function roleAllowedForTab(li, role) {
  const raw = li.getAttribute("data-rbac-allow") || "";
  const allowed = raw.split(/\s+/).filter(Boolean);
  return allowed.includes(role);
}

function applyRoleAccess(role) {
  document.body.dataset.talentflowRole = role;

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
    '<span class="d-block mt-1 small text-muted">Session is client-side demo only; production must enforce RBAC on the API.</span>';
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

function appendAuditEvent(event) {
  AUDIT_EVENTS.unshift(event);
  renderAuditTable();
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
    appendAuditEvent({
      time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      type: "audit_view",
      subject: "actor=j.lee@acme · action=view_rank_list · REQ-441",
      policy: "access log v1",
      outcome: "Shortlist viewed · wm-demo",
    });
  });
}

function initHumanReviewForm() {
  const form = el("formHumanReview");
  const feedback = el("reviewFeedback");
  if (!form) return;

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const decisionId =
      (el("reviewDecisionId") && el("reviewDecisionId").value.trim()) || "dec-unknown";
    const reason = el("reviewReason") ? el("reviewReason").value : "other";
    const notes = el("reviewNotes") ? el("reviewNotes").value.trim() : "";

    const ticketId = `hr-${Date.now().toString(36)}`;
    appendAuditEvent({
      time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      type: "human_review",
      subject: `ticket=${ticketId} · decision=${decisionId} · reason=${reason}`,
      policy: "review SLA tier=standard",
      outcome: notes ? "Queued; notes on file" : "Queued",
    });

    if (feedback) {
      feedback.textContent = `Ticket ${ticketId} created. Linked to ${decisionId}.`;
    }

    const modalEl = el("modalReviewConfirm");
    const modalBody = el("modalReviewConfirmBody");
    if (modalBody) {
      modalBody.textContent = `Ticket ${ticketId} recorded and appended to the audit log.`;
    }
    if (modalEl && window.bootstrap) {
      const modal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
      modal.show();
    }

    form.reset();
  });
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
  initTabTitles();
}

function bootApp(session) {
  showAppView();
  updateSessionDisplay(session);
  applyRoleAccess(session.role);
  renderAuditTable();
  attachAppListenersOnce();
}

function quickLogin(email) {
  const normalized = email.trim().toLowerCase();
  const user = DEMO_USERS.find((u) => u.email === normalized);
  if (!user) return;
  saveSession(user.email);
  bootApp(getSession());
}

function initQuickLoginButtons() {
  const pairs = [
    ["quickLoginApplicant", "maya.chen@example.com"],
    ["quickLoginEmployee", "jordan.lee@acme.example"],
    ["quickLoginAdmin", "ravi.patel@example.com"],
  ];
  for (const [id, email] of pairs) {
    const btn = el(id);
    if (btn) {
      btn.addEventListener("click", () => quickLogin(email));
    }
  }
}

function initLoginForm() {
  const form = el("loginForm");
  const err = el("loginError");
  if (!form) return;

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const emailInput = el("loginEmail");
    const passInput = el("loginPassword");
    const email = emailInput ? emailInput.value.trim().toLowerCase() : "";
    const password = passInput ? passInput.value : "";

    if (err) {
      err.classList.add("d-none");
      err.textContent = "";
    }

    const user = DEMO_USERS.find((u) => u.email === email);
    if (!user || user.password !== password) {
      if (err) {
        err.textContent = "Invalid email or password.";
        err.classList.remove("d-none");
      }
      return;
    }

    saveSession(user.email);
    bootApp(getSession());
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

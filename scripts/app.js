/**
 * Track 1 prototype — in-memory audit demo, RBAC (Ais-Spring / TalentFlow roles), human review.
 */

const AUDIT_EVENTS = [
  {
    time: "2026-04-08T14:02:11Z",
    type: "job_match",
    subject: "user=u-104 · feed=home",
    policy: "policy job-matching v2026.04 / ranker v3.2",
    outcome: "Top job: Senior Backend (score 0.87); factors: skills, geo, recency",
  },
  {
    time: "2026-04-08T14:02:12Z",
    type: "job_match",
    subject: "user=u-104 · job=j-9012",
    policy: "policy job-matching v2026.04",
    outcome: "Shown at position 1; explanation template em-geo-skills-01",
  },
  {
    time: "2026-04-08T14:18:40Z",
    type: "candidate_rank",
    subject: "req=r-441 · viewer=tenant-acme",
    policy: "policy candidate-rank v2026.03 / embed model text-embed-v2",
    outcome: "Ordered 24 candidates; top id=cand-A (0.91)",
  },
  {
    time: "2026-04-08T14:19:02Z",
    type: "audit_view",
    subject: "actor=rev-12 · action=view_rank_list",
    policy: "access log v1",
    outcome: "Rank list displayed; watermark wm-20260408-441",
  },
  {
    time: "2026-04-08T15:01:00Z",
    type: "human_review",
    subject: "ticket=hr-008 · decision=dec-20260408-001",
    policy: "review SLA tier=standard",
    outcome: "Queued; assigned pool=compliance-na",
  },
];

let auditFilter = "all";

const ROLE_BANNER = {
  seeker:
    "Viewing as Seeker (TalentFlow): job match and transparency; the Audit log tab is not available.",
  recruiter:
    "Viewing as Recruiter / employer / agency: requisitions and ranking tools; the Audit log tab is not available (compliance auditors only).",
  auditor:
    "Viewing as Auditor: full compliance navigation including the Audit log tab (append-only decision records).",
  admin:
    "Viewing as Admin: full navigation including Audit log and governance previews.",
};

function el(id) {
  return document.getElementById(id);
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

  countLabel.textContent = `${rows.length} event(s) shown`;

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
  const items = document.querySelectorAll("li[data-rbac-allow]");
  let mustReselect = false;

  for (const li of items) {
    const show = roleAllowedForTab(li, role);
    li.classList.toggle("d-none", !show);
    li.setAttribute("aria-hidden", show ? "false" : "true");

    const btn = li.querySelector(".nav-link[data-bs-toggle='tab']");
    if (!show && btn && btn.classList.contains("active")) {
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
  const base =
    'Preview mode: navigation matches the selected role (see <a href="https://github.com/Shnmg1/Ais-Spring.git">Ais-Spring / TalentFlow</a>). ';
  const line = ROLE_BANNER[role] || "";
  banner.innerHTML = base + "<span class=\"d-block mt-1\">" + escapeHtml(line) + "</span>";
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

function initRoleSelect() {
  const sel = el("roleSelect");
  if (!sel) return;
  sel.addEventListener("change", () => applyRoleAccess(sel.value));
  applyRoleAccess(sel.value);
}

function initRankViewButton() {
  const btn = el("btnLogRankView");
  if (!btn) return;
  btn.addEventListener("click", () => {
    appendAuditEvent({
      time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      type: "audit_view",
      subject: "actor=demo-reviewer · action=view_rank_list",
      policy: "access log v1",
      outcome: "Demo: ranking view logged",
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
      feedback.textContent = `Ticket ${ticketId} created (demo). Linked to decision ${decisionId}.`;
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

function init() {
  renderAuditTable();
  initAuditFilters();
  initRoleSelect();
  initRankViewButton();
  initHumanReviewForm();
}

init();

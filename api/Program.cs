using api.Data;
using api.Models;
using Microsoft.EntityFrameworkCore;
using MySqlConnector;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();
builder.Services.AddCors(options =>
{
    options.AddPolicy("FrontendPolicy", policy =>
        policy
            // file:// pages send Origin: "null"; localhost dev servers use explicit origins
            .SetIsOriginAllowed(origin =>
            {
                if (string.IsNullOrWhiteSpace(origin) || origin is "null")
                {
                    return true;
                }

                var allowed = new[]
                {
                    "http://localhost:5500",
                    "http://127.0.0.1:5500",
                    "http://localhost:5113",
                    "http://127.0.0.1:5113",
                    "http://localhost:3000",
                    "http://127.0.0.1:3000",
                };
                return Array.Exists(allowed, o => string.Equals(o, origin, StringComparison.OrdinalIgnoreCase));
            })
            .AllowAnyHeader()
            .AllowAnyMethod());
});

var rawConnectionString = builder.Configuration.GetConnectionString("DefaultConnection")
    ?? throw new InvalidOperationException("Missing ConnectionStrings:DefaultConnection.");

// AutoDetect opens a live DB connection during options setup and burns pooled connections; cheap
// hosted MySQL often caps max_user_connections (e.g. 10) — use an explicit version + small pool.
var csb = new MySqlConnectionStringBuilder(rawConnectionString)
{
    MaximumPoolSize = uint.TryParse(
        builder.Configuration["Database:MaximumPoolSize"],
        out var mps) && mps > 0
        ? mps
        : 5,
    MinimumPoolSize = 0,
};

var serverVersionText = builder.Configuration["Database:ServerVersion"]?.Trim();
var serverVersion = string.IsNullOrEmpty(serverVersionText)
    ? ServerVersion.Parse("8.0.36-mysql")
    : ServerVersion.Parse(serverVersionText);

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseMySql(csb.ConnectionString, serverVersion));

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseCors("FrontendPolicy");

app.MapGet("/health/db", async (AppDbContext db, CancellationToken ct) =>
{
    var canConnect = await db.Database.CanConnectAsync(ct);
    return canConnect
        ? Results.Ok(new { status = "ok", database = "connected" })
        : Results.Problem("Unable to connect to MySQL database.");
});

app.MapGet("/api/users", async (AppDbContext db, CancellationToken ct) =>
    await db.Users.AsNoTracking().ToListAsync(ct));

app.MapGet("/api/reviewers", async (AppDbContext db, CancellationToken ct) =>
    await db.Reviewers.AsNoTracking().ToListAsync(ct));

app.MapGet("/api/scoring-criteria", async (AppDbContext db, CancellationToken ct) =>
    await db.ScoringCriteria.AsNoTracking().ToListAsync(ct));

app.MapGet("/api/algorithms", async (AppDbContext db, CancellationToken ct) =>
    await db.Algorithms.AsNoTracking().ToListAsync(ct));

app.MapGet("/api/decision-factors", async (AppDbContext db, CancellationToken ct) =>
    await db.DecisionFactors.AsNoTracking().ToListAsync(ct));

app.MapGet("/api/transparency-portal", async (AppDbContext db, CancellationToken ct) =>
    await db.TransparencyPortal.AsNoTracking().ToListAsync(ct));

app.MapGet("/api/audit-logs", async (AppDbContext db, CancellationToken ct) =>
    await db.AuditLogs.AsNoTracking().OrderByDescending(a => a.LogId).ToListAsync(ct));

app.MapPost("/api/audit-logs/append", async (AppDbContext db, AppendAuditRequest body, CancellationToken ct) =>
{
    var msg = (body.Summary ?? "").Trim();
    if (msg.Length == 0)
    {
        return Results.BadRequest(new { message = "Summary is required." });
    }

    if (msg.Length > 50)
    {
        msg = msg[..50];
    }

    var nextLogId = (await db.AuditLogs.MaxAsync(a => (int?)a.LogId, ct) ?? 0) + 1;
    db.AuditLogs.Add(new AuditLog
    {
        LogId = nextLogId,
        AuditTimestamp = DateTime.UtcNow,
        ComplianceStatus = msg,
        ImpactRatio = null,
        UserId = body.UserId,
        ReviewerId = body.ReviewerId,
        FactorId = body.FactorId
    });
    await db.SaveChangesAsync(ct);
    return Results.Ok(new { logId = nextLogId });
});

app.MapGet("/api/user-decision-factors", async (AppDbContext db, CancellationToken ct) =>
    await db.UserDecisionFactors.AsNoTracking().ToListAsync(ct));

app.MapGet("/api/user-appeals", async (AppDbContext db, CancellationToken ct) =>
    await db.UserAppeals.AsNoTracking().ToListAsync(ct));

app.MapGet("/api/algorithm-benchmarks", async (AppDbContext db, CancellationToken ct) =>
    await db.AlgorithmBenchmarks.AsNoTracking().ToListAsync(ct));

app.MapGet("/api/algorithm-powers", async (AppDbContext db, CancellationToken ct) =>
    await db.AlgorithmPowers.AsNoTracking().ToListAsync(ct));

app.MapGet("/api/recruiter/ranked-talent", async (AppDbContext db, CancellationToken ct) =>
{
    var users = await db.Users
        .AsNoTracking()
        .Where(u =>
            u.UserRole.ToLower() == "seeker" ||
            u.UserRole.ToLower() == "applicant" ||
            u.UserRole.ToLower() == "candidate")
        .OrderBy(u => u.Name)
        .ToListAsync(ct);

    if (users.Count == 0)
    {
        return Results.Ok(Array.Empty<object>());
    }

    var userIds = users.Select(u => u.UserId).ToList();

    var flat = await (
        from udf in db.UserDecisionFactors.AsNoTracking()
        join df in db.DecisionFactors.AsNoTracking() on udf.FactorId equals df.FactorId
        join algo in db.Algorithms.AsNoTracking() on df.AlgoId equals algo.AlgoId
        where userIds.Contains(udf.UserId)
        select new { udf.UserId, Impact = df.ImpactScore ?? 0m, algo.ModelName, algo.AlgoId }
    ).ToListAsync(ct);

    var grouped = flat
        .GroupBy(x => x.UserId)
        .ToDictionary(
            g => g.Key,
            g => new
            {
                AvgFit = g.Average(x => x.Impact),
                ModelName = g.Select(x => x.ModelName).FirstOrDefault() ?? "Model",
                AlgoId = g.Min(x => x.AlgoId)
            });

    var candidates = users.Select((u, index) =>
    {
        grouped.TryGetValue(u.UserId, out var g);
        var fit = g?.AvgFit ?? 0m;
        var model = g?.ModelName ?? "No linked decision factors";
        var algoId = g?.AlgoId ?? 0;
        return new
        {
            rank = index + 1,
            userId = u.UserId,
            candidateName = u.Name,
            requisition = model,
            aiFit = Math.Round(fit, 2, MidpointRounding.AwayFromZero),
            signals = $"Role={u.UserRole}",
            runId = algoId > 0 ? $"algo-{algoId}" : "—"
        };
    });

    return Results.Ok(candidates);
});

app.MapGet("/api/recruiter/decision-details/{userId:int}", async (int userId, AppDbContext db, CancellationToken ct) =>
{
    var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.UserId == userId, ct);
    if (user is null)
    {
        return Results.NotFound(new { message = "User not found." });
    }

    var udfs = await db.UserDecisionFactors.AsNoTracking()
        .Where(udf => udf.UserId == userId)
        .Select(udf => new
        {
            udf.FactorId,
            Impact = udf.DecisionFactor.ImpactScore,
            FactorName = udf.DecisionFactor.FactorName,
            AlgoId = udf.DecisionFactor.AlgoId,
            ModelName = udf.DecisionFactor.Algorithm.ModelName
        })
        .OrderBy(x => x.FactorId)
        .ToListAsync(ct);

    var algoIds = udfs.Select(u => u.AlgoId).Distinct().ToList();
    var benchLinks = await db.AlgorithmBenchmarks.AsNoTracking()
        .Where(ab => algoIds.Contains(ab.AlgoId))
        .Join(
            db.ScoringCriteria.AsNoTracking(),
            ab => ab.CriteriaId,
            sc => sc.CriteriaId,
            (ab, sc) => new { ab.AlgoId, sc })
        .ToListAsync(ct);

    var benchByAlgo = benchLinks
        .GroupBy(x => x.AlgoId)
        .ToDictionary(g => g.Key, g => g.First().sc);

    var factors = udfs.Select(u =>
    {
        benchByAlgo.TryGetValue(u.AlgoId, out var sc);
        var fn = string.IsNullOrWhiteSpace(u.FactorName)
            ? $"Factor {u.FactorId}"
            : u.FactorName!.Trim();
        return new
        {
            factorId = u.FactorId,
            factorName = fn,
            impactScore = u.Impact,
            modelName = u.ModelName,
            algoId = u.AlgoId,
            benchmarkJobTitle = sc?.JobTitle,
            benchmarkMinExperience = sc?.MinExperience,
            benchmarkRequiredSkills = sc?.RequiredSkills,
            criteriaId = sc?.CriteriaId
        };
    }).ToList();

    return Results.Ok(new
    {
        userId = user.UserId,
        name = user.Name,
        factors
    });
});

app.MapGet("/api/recruiter/candidate-policy-gap/{userId:int}", async (int userId, AppDbContext db, CancellationToken ct) =>
{
    var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.UserId == userId, ct);
    if (user is null)
    {
        return Results.NotFound(new { message = "User not found." });
    }

    var hay = $"{user.Name} {user.Email} {user.UserRole}".ToLowerInvariant();
    var factorNames = await db.UserDecisionFactors.AsNoTracking()
        .Where(udf => udf.UserId == userId)
        .Select(udf => udf.DecisionFactor.FactorName ?? "")
        .ToListAsync(ct);
    foreach (var n in factorNames)
    {
        hay += " " + n.ToLowerInvariant();
    }

    var rawCriteria = await (
        from udf in db.UserDecisionFactors.AsNoTracking()
        join df in db.DecisionFactors.AsNoTracking() on udf.FactorId equals df.FactorId
        join ab in db.AlgorithmBenchmarks.AsNoTracking() on df.AlgoId equals ab.AlgoId
        join sc in db.ScoringCriteria.AsNoTracking() on ab.CriteriaId equals sc.CriteriaId
        where udf.UserId == userId
        select sc
    ).ToListAsync(ct);

    var criteriaList = rawCriteria
        .GroupBy(s => s.CriteriaId)
        .Select(g => g.First())
        .ToList();

    var missing = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var policyLines = new List<string>();
    foreach (var sc in criteriaList)
    {
        var title = sc.JobTitle ?? "Role";
        var req = sc.RequiredSkills ?? "";
        var min = sc.MinExperience?.ToString() ?? "—";
        policyLines.Add($"{title}: required — {req}; min experience — {min} yrs");
        foreach (var tok in ConsultantNarrative.TokenizeSkills(req))
        {
            if (tok.Length < 2)
            {
                continue;
            }

            if (!hay.Contains(tok.ToLowerInvariant()))
            {
                missing.Add(tok);
            }
        }
    }

    return Results.Ok(new
    {
        missingSkills = missing.ToList(),
        policyLines
    });
});

app.MapGet("/api/recruiter/candidate-policy-benchmarks/{userId:int}", async (int userId, AppDbContext db, CancellationToken ct) =>
{
    var exists = await db.Users.AsNoTracking().AnyAsync(u => u.UserId == userId, ct);
    if (!exists)
    {
        return Results.NotFound(new { message = "User not found." });
    }

    var flat = await (
        from udf in db.UserDecisionFactors.AsNoTracking()
        join df in db.DecisionFactors.AsNoTracking() on udf.FactorId equals df.FactorId
        join ab in db.AlgorithmBenchmarks.AsNoTracking() on df.AlgoId equals ab.AlgoId
        join sc in db.ScoringCriteria.AsNoTracking() on ab.CriteriaId equals sc.CriteriaId
        where udf.UserId == userId
        select new
        {
            sc.CriteriaId,
            jobTitle = sc.JobTitle ?? "—",
            requiredSkills = sc.RequiredSkills ?? "—",
            minExperience = sc.MinExperience,
            algoId = df.AlgoId,
            modelName = df.Algorithm.ModelName
        }
    ).ToListAsync(ct);

    var rows = flat
        .GroupBy(x => x.CriteriaId)
        .Select(g => g.First())
        .OrderBy(x => x.CriteriaId)
        .ToList();

    return Results.Ok(rows);
});

app.MapGet("/api/recruiter/review-requests", async (AppDbContext db, CancellationToken ct) =>
{
    var portalRows = await db.TransparencyPortal
        .AsNoTracking()
        .OrderByDescending(tp => tp.RequestId)
        .Select(tp => new
        {
            tp.RequestId,
            ApplicantUserId = tp.UserId,
            ticketId = $"HR-{tp.RequestId}",
            requestId = tp.RequestId,
            applicant = tp.User.Name,
            decisionId = $"dec-{tp.RequestId}",
            reason = tp.TierLevel ?? "other",
            submittedAtUtc = $"req-{tp.RequestId}",
            status = tp.RequestStatus,
            reviewerId = tp.ReviewerId,
            reviewerName = tp.Reviewer != null ? tp.Reviewer.EmployeeName : null,
            requestSource = tp.RequestSource
        })
        .ToListAsync(ct);

    var userIds = portalRows.Select(r => r.ApplicantUserId).Distinct().ToList();
    var ratioLogs = await db.AuditLogs.AsNoTracking()
        .Where(a => a.UserId != null && userIds.Contains(a.UserId.Value) && a.ImpactRatio != null)
        .OrderByDescending(a => a.LogId)
        .Select(a => new { a.UserId, a.ImpactRatio })
        .ToListAsync(ct);

    var ratioByUser = new Dictionary<int, decimal>();
    foreach (var l in ratioLogs)
    {
        if (l.UserId is null) continue;
        var uid = l.UserId.Value;
        if (!ratioByUser.ContainsKey(uid))
        {
            ratioByUser[uid] = l.ImpactRatio!.Value;
        }
    }

    var reviewers = await db.Reviewers.AsNoTracking().OrderBy(r => r.ReviewerId).ToListAsync(ct);

    var result = portalRows.Select(r => new
    {
        r.ticketId,
        r.requestId,
        applicantUserId = r.ApplicantUserId,
        r.applicant,
        r.decisionId,
        r.reason,
        r.submittedAtUtc,
        r.status,
        r.reviewerId,
        r.reviewerName,
        fairnessImpactRatio = ratioByUser.TryGetValue(r.ApplicantUserId, out var ratio) ? (decimal?)ratio : null,
        suggestedSpecialist = ReviewRequestRouting.SuggestSpecialistName(r.reason, reviewers),
        sourceLabel = string.Equals(r.requestSource, "SystemFlag", StringComparison.OrdinalIgnoreCase)
            ? "System Flag"
            : "Applicant Dispute"
    }).ToList();

    return Results.Ok(result);
});

app.MapPost("/api/recruiter/claim-review", async (AppDbContext db, ClaimReviewRequest body, CancellationToken ct) =>
{
    if (body.RequestId <= 0 || body.ReviewerId <= 0)
    {
        return Results.BadRequest(new { message = "requestId and reviewerId are required." });
    }

    var tp = await db.TransparencyPortal
        .FirstOrDefaultAsync(t => t.RequestId == body.RequestId, ct);

    if (tp is null)
    {
        return Results.NotFound(new { message = "Review request not found." });
    }

    if (tp.ReviewerId.HasValue)
    {
        return Results.Conflict(new { message = "Request already assigned to a reviewer." });
    }

    var st = (tp.RequestStatus ?? "").Trim();
    var canClaim = string.Equals(st, "Pending", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(st, "Escalated", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(st, "Under Ethical Review", StringComparison.OrdinalIgnoreCase);
    if (!canClaim)
    {
        return Results.BadRequest(new { message = "Only Pending, Escalated, or Under Ethical Review requests can be claimed." });
    }

    var reviewerExists = await db.Reviewers.AsNoTracking()
        .AnyAsync(r => r.ReviewerId == body.ReviewerId, ct);
    if (!reviewerExists)
    {
        return Results.BadRequest(new { message = "Reviewer not found." });
    }

    tp.ReviewerId = body.ReviewerId;
    tp.RequestStatus = "In Progress";

    var nextLogId = (await db.AuditLogs.MaxAsync(a => (int?)a.LogId, ct) ?? 0) + 1;
    var auditMessage = $"Reviewer {body.ReviewerId} started review of Request {body.RequestId}";
    if (auditMessage.Length > 50)
    {
        auditMessage = auditMessage[..50];
    }

    db.AuditLogs.Add(new AuditLog
    {
        LogId = nextLogId,
        AuditTimestamp = DateTime.UtcNow,
        ComplianceStatus = auditMessage,
        ImpactRatio = null,
        UserId = tp.UserId,
        ReviewerId = body.ReviewerId,
        FactorId = null
    });

    await db.SaveChangesAsync(ct);

    var reviewerName = await db.Reviewers.AsNoTracking()
        .Where(r => r.ReviewerId == body.ReviewerId)
        .Select(r => r.EmployeeName)
        .FirstAsync(ct);

    return Results.Ok(new
    {
        requestId = body.RequestId,
        reviewerId = body.ReviewerId,
        reviewerName,
        status = tp.RequestStatus
    });
});

app.MapPost("/api/recruiter/resolve-review", async (AppDbContext db, ResolveReviewRequest body, CancellationToken ct) =>
{
    if (body.RequestId <= 0 || string.IsNullOrWhiteSpace(body.FinalAction))
    {
        return Results.BadRequest(new { message = "requestId and finalAction are required." });
    }

    var human = (body.HumanJustification ?? "").Trim();
    if (human.Length == 0)
    {
        return Results.BadRequest(new { message = "humanJustification is required." });
    }

    if (human.Length > 4000)
    {
        human = human[..4000];
    }

    var normalized = body.FinalAction.Trim();
    string canonical;
    bool clearReviewer = false;

    if (string.Equals(normalized, "Upheld", StringComparison.OrdinalIgnoreCase))
    {
        canonical = "Upheld";
    }
    else if (string.Equals(normalized, "Overturned", StringComparison.OrdinalIgnoreCase))
    {
        canonical = "Overturned";
    }
    else if (string.Equals(normalized, "Escalate", StringComparison.OrdinalIgnoreCase))
    {
        canonical = "Escalated";
        clearReviewer = true;
    }
    else
    {
        return Results.BadRequest(new { message = "finalAction must be Upheld, Overturned, or Escalate." });
    }

    var tp = await db.TransparencyPortal
        .FirstOrDefaultAsync(t => t.RequestId == body.RequestId, ct);

    if (tp is null)
    {
        return Results.NotFound(new { message = "Review request not found." });
    }

    if (!string.Equals(tp.RequestStatus, "In Progress", StringComparison.OrdinalIgnoreCase))
    {
        return Results.BadRequest(new { message = "Only requests In Progress can be resolved." });
    }

    var actingReviewerId = tp.ReviewerId;

    tp.RequestStatus = canonical;
    if (clearReviewer)
    {
        tp.ReviewerId = null;
    }

    tp.HumanJustification = human;

    var appeal = await db.UserAppeals.FirstOrDefaultAsync(a => a.RequestId == body.RequestId, ct);
    if (appeal is not null)
    {
        appeal.ResolutionNotes = human;
    }

    var nextLogId = (await db.AuditLogs.MaxAsync(a => (int?)a.LogId, ct) ?? 0) + 1;
    var auditMessage = $"Req {body.RequestId} {canonical}";
    if (auditMessage.Length > 50)
    {
        auditMessage = auditMessage[..50];
    }

    db.AuditLogs.Add(new AuditLog
    {
        LogId = nextLogId,
        AuditTimestamp = DateTime.UtcNow,
        ComplianceStatus = auditMessage,
        ImpactRatio = null,
        UserId = tp.UserId,
        ReviewerId = actingReviewerId,
        FactorId = null
    });

    var notePreview = $"Res {body.RequestId}: {human.Replace('\r', ' ').Replace('\n', ' ')}";
    if (notePreview.Length > 50)
    {
        notePreview = notePreview[..50];
    }

    var nextLogId2 = nextLogId + 1;
    db.AuditLogs.Add(new AuditLog
    {
        LogId = nextLogId2,
        AuditTimestamp = DateTime.UtcNow,
        ComplianceStatus = notePreview,
        ImpactRatio = null,
        UserId = tp.UserId,
        ReviewerId = actingReviewerId,
        FactorId = null
    });

    await db.SaveChangesAsync(ct);

    return Results.Ok(new
    {
        requestId = body.RequestId,
        finalAction = canonical,
        status = tp.RequestStatus
    });
});

app.MapPost("/api/recruiter/address-review", async (AppDbContext db, AddressReviewRequest body, CancellationToken ct) =>
{
    if (body.RequestId <= 0)
    {
        return Results.BadRequest(new { message = "requestId is required." });
    }

    var summary = (body.Summary ?? "").Trim();
    if (summary.Length == 0)
    {
        return Results.BadRequest(new { message = "Summary is required." });
    }

    if (summary.Length > 50)
    {
        summary = summary[..50];
    }

    var tp = await db.TransparencyPortal
        .FirstOrDefaultAsync(t => t.RequestId == body.RequestId, ct);

    if (tp is null)
    {
        return Results.NotFound(new { message = "Review request not found." });
    }

    if (!string.Equals(tp.RequestStatus, "In Progress", StringComparison.OrdinalIgnoreCase))
    {
        return Results.BadRequest(new { message = "Only requests In Progress can be addressed." });
    }

    var nextLogId = (await db.AuditLogs.MaxAsync(a => (int?)a.LogId, ct) ?? 0) + 1;
    db.AuditLogs.Add(new AuditLog
    {
        LogId = nextLogId,
        AuditTimestamp = DateTime.UtcNow,
        ComplianceStatus = summary,
        ImpactRatio = null,
        UserId = tp.UserId,
        ReviewerId = tp.ReviewerId,
        FactorId = null
    });

    await db.SaveChangesAsync(ct);

    return Results.Ok(new { requestId = body.RequestId, status = tp.RequestStatus });
});

app.MapPost("/api/recruiter/escalate-review", async (AppDbContext db, EscalateReviewRequest body, CancellationToken ct) =>
{
    if (body.RequestId <= 0)
    {
        return Results.BadRequest(new { message = "requestId is required." });
    }

    var tp = await db.TransparencyPortal
        .FirstOrDefaultAsync(t => t.RequestId == body.RequestId, ct);

    if (tp is null)
    {
        return Results.NotFound(new { message = "Review request not found." });
    }

    if (!string.Equals(tp.RequestStatus, "In Progress", StringComparison.OrdinalIgnoreCase))
    {
        return Results.BadRequest(new { message = "Only requests In Progress can be escalated." });
    }

    tp.RequestStatus = "Escalated";
    tp.ReviewerId = null;

    var nextLogId = (await db.AuditLogs.MaxAsync(a => (int?)a.LogId, ct) ?? 0) + 1;
    var auditMessage = $"Req {body.RequestId} escalated to manager";
    if (auditMessage.Length > 50)
    {
        auditMessage = auditMessage[..50];
    }

    db.AuditLogs.Add(new AuditLog
    {
        LogId = nextLogId,
        AuditTimestamp = DateTime.UtcNow,
        ComplianceStatus = auditMessage,
        ImpactRatio = null,
        UserId = tp.UserId,
        ReviewerId = null,
        FactorId = null
    });

    await db.SaveChangesAsync(ct);

    return Results.Ok(new { requestId = body.RequestId, status = tp.RequestStatus });
});

app.MapPost("/api/recruiter/escalate-ethics-review", async (AppDbContext db, EthicsEscalateRequest body, CancellationToken ct) =>
{
    if (body.RequestId <= 0)
    {
        return Results.BadRequest(new { message = "requestId is required." });
    }

    var tp = await db.TransparencyPortal
        .FirstOrDefaultAsync(t => t.RequestId == body.RequestId, ct);

    if (tp is null)
    {
        return Results.NotFound(new { message = "Review request not found." });
    }

    if (!string.Equals(tp.RequestStatus, "In Progress", StringComparison.OrdinalIgnoreCase))
    {
        return Results.BadRequest(new { message = "Only requests In Progress can be escalated to ethics." });
    }

    var ratio = await db.AuditLogs.AsNoTracking()
        .Where(a => a.UserId == tp.UserId && a.ImpactRatio != null)
        .OrderByDescending(a => a.LogId)
        .Select(a => a.ImpactRatio)
        .FirstOrDefaultAsync(ct);

    if (ratio is null || ratio >= 0.7m)
    {
        return Results.BadRequest(new { message = "Ethics escalation requires a fairness-flagged applicant (latest impact ratio below 0.70)." });
    }

    tp.RequestStatus = "Under Ethical Review";
    tp.ReviewerId = null;

    var nextLogId = (await db.AuditLogs.MaxAsync(a => (int?)a.LogId, ct) ?? 0) + 1;
    var auditMessage = $"Req {body.RequestId} escalated to Ethics Board";
    if (auditMessage.Length > 50)
    {
        auditMessage = auditMessage[..50];
    }

    db.AuditLogs.Add(new AuditLog
    {
        LogId = nextLogId,
        AuditTimestamp = DateTime.UtcNow,
        ComplianceStatus = auditMessage,
        ImpactRatio = ratio,
        UserId = tp.UserId,
        ReviewerId = null,
        FactorId = null
    });

    await db.SaveChangesAsync(ct);

    return Results.Ok(new { requestId = body.RequestId, status = tp.RequestStatus, notifiedRoles = new[] { "admin", "auditor" } });
});

app.MapGet("/api/compliance/ethics-pending-count", async (AppDbContext db, CancellationToken ct) =>
{
    var n = await db.TransparencyPortal.AsNoTracking().CountAsync(
        t => t.RequestStatus != null &&
             string.Equals(t.RequestStatus.Trim(), "Under Ethical Review", StringComparison.OrdinalIgnoreCase),
        ct);
    return Results.Ok(new { count = n });
});

app.MapGet("/api/recruiter/model-impact-comparison", async (AppDbContext db, CancellationToken ct) =>
{
    var flat = await db.DecisionFactors.AsNoTracking()
        .Select(df => new
        {
            df.AlgoId,
            ModelName = df.Algorithm.ModelName,
            df.ImpactScore
        })
        .ToListAsync(ct);

    var rows = flat
        .GroupBy(x => new { x.AlgoId, x.ModelName })
        .Select(g =>
        {
            var scores = g.Select(x => x.ImpactScore).Where(s => s != null).Select(s => s!.Value).ToList();
            var avg = scores.Count > 0 ? scores.Average() : 0m;
            return new
            {
                algoId = g.Key.AlgoId,
                modelName = g.Key.ModelName,
                factorCount = g.Count(),
                avgImpact = Math.Round(avg, 4, MidpointRounding.AwayFromZero),
                minImpact = scores.Count > 0 ? scores.Min() : 0m,
                maxImpact = scores.Count > 0 ? scores.Max() : 0m
            };
        })
        .OrderBy(x => x.algoId)
        .ToList();

    return Results.Ok(rows);
});

app.MapPost("/api/recruiter/review-requests", async (AppDbContext db, CreateReviewRequest request, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(request.RequesterEmail))
    {
        return Results.BadRequest(new { message = "RequesterEmail is required." });
    }

    var requester = await db.Users
        .FirstOrDefaultAsync(u => u.Email == request.RequesterEmail.Trim().ToLower(), ct);

    if (requester is null)
    {
        return Results.BadRequest(new { message = "Requester user not found." });
    }

    var nextRequestId = (await db.TransparencyPortal.MaxAsync(t => (int?)t.RequestId, ct) ?? 0) + 1;
    var nextAppealId = (await db.UserAppeals.MaxAsync(a => (int?)a.AppealId, ct) ?? 0) + 1;

    var src = (request.Source ?? "ApplicantDispute").Trim();
    if (!string.Equals(src, "SystemFlag", StringComparison.OrdinalIgnoreCase) &&
        !string.Equals(src, "ApplicantDispute", StringComparison.OrdinalIgnoreCase))
    {
        src = "ApplicantDispute";
    }

    var noteText = (request.Notes ?? "").Trim();
    if (noteText.Length > 4000)
    {
        noteText = noteText[..4000];
    }

    var transparencyRequest = new TransparencyPortal
    {
        RequestId = nextRequestId,
        RequestStatus = "Pending",
        TierLevel = string.IsNullOrWhiteSpace(request.Reason) ? "other" : request.Reason.Trim(),
        UserId = requester.UserId,
        ReviewerId = null,
        RequestSource = src
    };

    var appeal = new UserAppeal
    {
        AppealId = nextAppealId,
        UserId = requester.UserId,
        RequestId = nextRequestId,
        AppealDate = DateOnly.FromDateTime(DateTime.UtcNow),
        AppealNotes = noteText.Length > 0 ? noteText : null
    };

    db.TransparencyPortal.Add(transparencyRequest);
    db.UserAppeals.Add(appeal);
    await db.SaveChangesAsync(ct);

    return Results.Created($"/api/recruiter/review-requests/{nextRequestId}", new
    {
        ticketId = $"HR-{nextRequestId}",
        requestId = nextRequestId,
        status = "Pending",
        reason = transparencyRequest.TierLevel,
        decisionId = request.DecisionId,
        notes = request.Notes,
        requestSource = transparencyRequest.RequestSource
    });
});

app.MapPost("/api/seeker/formal-dispute", async (AppDbContext db, FormalDisputeRequest request, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(request.RequesterEmail))
    {
        return Results.BadRequest(new { message = "RequesterEmail is required." });
    }

    var requester = await db.Users
        .FirstOrDefaultAsync(u => u.Email == request.RequesterEmail.Trim().ToLower(), ct);

    if (requester is null)
    {
        return Results.BadRequest(new { message = "Requester user not found." });
    }

    var ur = (requester.UserRole ?? "").ToLowerInvariant();
    if (!ur.Contains("seek") && !ur.Contains("applicant") && !ur.Contains("candid"))
    {
        return Results.BadRequest(new { message = "Formal dispute is only available for applicant accounts." });
    }

    var nextRequestId = (await db.TransparencyPortal.MaxAsync(t => (int?)t.RequestId, ct) ?? 0) + 1;
    var nextAppealId = (await db.UserAppeals.MaxAsync(a => (int?)a.AppealId, ct) ?? 0) + 1;

    var noteText = (request.Notes ?? "").Trim();
    if (noteText.Length > 4000)
    {
        noteText = noteText[..4000];
    }

    var transparencyRequest = new TransparencyPortal
    {
        RequestId = nextRequestId,
        RequestStatus = "Pending",
        TierLevel = string.IsNullOrWhiteSpace(request.Reason) ? "other" : request.Reason.Trim(),
        UserId = requester.UserId,
        ReviewerId = null,
        RequestSource = "ApplicantDispute"
    };

    var appeal = new UserAppeal
    {
        AppealId = nextAppealId,
        UserId = requester.UserId,
        RequestId = nextRequestId,
        AppealDate = DateOnly.FromDateTime(DateTime.UtcNow),
        AppealNotes = noteText.Length > 0 ? noteText : null
    };

    db.TransparencyPortal.Add(transparencyRequest);
    db.UserAppeals.Add(appeal);
    await db.SaveChangesAsync(ct);

    return Results.Created($"/api/seeker/formal-dispute/{nextRequestId}", new
    {
        ticketId = $"HR-{nextRequestId}",
        requestId = nextRequestId,
        status = "Pending",
        reason = transparencyRequest.TierLevel,
        decisionId = request.DecisionId,
        notes = request.Notes,
        requestSource = "ApplicantDispute"
    });
});

app.MapPost("/api/auth/login", async (AppDbContext db, IConfiguration config, LoginRequest req, CancellationToken ct) =>
{
    var expected = config["Auth:DemoPassword"];
    if (string.IsNullOrEmpty(expected))
    {
        return Results.Json(
            new { message = "Auth:DemoPassword is not configured." },
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }

    if (string.IsNullOrWhiteSpace(req.Email) || req.Password != expected)
    {
        return Results.Json(
            new { message = "Invalid email or password." },
            statusCode: StatusCodes.Status401Unauthorized);
    }

    var email = req.Email.Trim().ToLowerInvariant();
    var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Email.ToLower() == email, ct);
    if (user is null)
    {
        return Results.BadRequest(new { message = "Email not registered in the database." });
    }

    return Results.Ok(new
    {
        email = user.Email,
        name = user.Name,
        role = UiRoleMapper.FromUserRole(user.UserRole),
        department = user.Department,
        jobTitle = user.JobTitle
    });
});

if (app.Environment.IsDevelopment())
{
    app.MapPost("/api/auth/quick-login", async (AppDbContext db, QuickLoginRequest req, CancellationToken ct) =>
    {
        var target = (req.TargetRole ?? "").Trim().ToLowerInvariant();
        if (target is not ("seeker" or "recruiter" or "admin" or "auditor"))
        {
            return Results.BadRequest(new { message = "targetRole must be seeker, recruiter, admin, or auditor." });
        }

        var all = await db.Users.AsNoTracking().OrderBy(u => u.UserId).ToListAsync(ct);
        var match = all.FirstOrDefault(u => UiRoleMapper.FromUserRole(u.UserRole) == target);
        if (match is null)
        {
            return Results.NotFound(new { message = "No user with that role was found." });
        }

        return Results.Ok(new
        {
            email = match.Email,
            name = match.Name,
            role = UiRoleMapper.FromUserRole(match.UserRole),
            department = match.Department,
            jobTitle = match.JobTitle
        });
    });
}

app.MapGet("/api/profile", async (string? email, AppDbContext db, CancellationToken ct) =>
{
    var e = (email ?? "").Trim().ToLowerInvariant();
    if (e.Length == 0)
    {
        return Results.BadRequest(new { message = "email is required." });
    }

    var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Email.ToLower() == e, ct);
    return user is null
        ? Results.NotFound(new { message = "User not found." })
        : Results.Ok(new
        {
            userId = user.UserId,
            name = user.Name,
            email = user.Email,
            userRole = user.UserRole,
            department = user.Department,
            jobTitle = user.JobTitle
        });
});

app.MapGet("/api/dashboard/metrics", async (string? email, AppDbContext db, CancellationToken ct) =>
{
    var now = DateTime.UtcNow;
    var dayAgo = now.AddDays(-1);
    var weekAgo = now.AddDays(-7);

    var audit24h = await db.AuditLogs.AsNoTracking().CountAsync(a => a.AuditTimestamp >= dayAgo, ct);
    var audit7d = await db.AuditLogs.AsNoTracking().CountAsync(a => a.AuditTimestamp >= weekAgo, ct);
    var usersCount = await db.Users.AsNoTracking().CountAsync(ct);
    var pendingReviews = await db.TransparencyPortal.AsNoTracking()
        .CountAsync(t => t.RequestStatus != null && t.RequestStatus.ToLower() == "pending", ct);
    var criteriaCount = await db.ScoringCriteria.AsNoTracking().CountAsync(ct);
    var algorithmsCount = await db.Algorithms.AsNoTracking().CountAsync(ct);
    var udfCount = await db.UserDecisionFactors.AsNoTracking().CountAsync(ct);
    var seekerCount = await db.Users.AsNoTracking().CountAsync(u =>
        u.UserRole.ToLower() == "seeker" ||
        u.UserRole.ToLower() == "applicant" ||
        u.UserRole.ToLower() == "candidate", ct);

    object? seeker = null;
    var e = (email ?? "").Trim().ToLowerInvariant();
    if (e.Length > 0)
    {
        var u = await db.Users.AsNoTracking().FirstOrDefaultAsync(x => x.Email.ToLower() == e, ct);
        if (u is not null)
        {
            var impacts = await db.UserDecisionFactors.AsNoTracking()
                .Where(udf => udf.UserId == u.UserId)
                .Select(udf => udf.DecisionFactor.ImpactScore)
                .Where(s => s != null)
                .Select(s => s!.Value)
                .ToListAsync(ct);
            var avgImpact = impacts.Count > 0
                ? Math.Round(impacts.Average(x => (double)x), 2, MidpointRounding.AwayFromZero)
                : (double?)null;
            var transparencyCount = await db.TransparencyPortal.AsNoTracking()
                .CountAsync(t => t.UserId == u.UserId, ct);
            var appealsCount = await db.UserAppeals.AsNoTracking().CountAsync(a => a.UserId == u.UserId, ct);
            seeker = new
            {
                linkedFactors = impacts.Count,
                avgImpact,
                transparencyRequests = transparencyCount,
                appeals = appealsCount
            };
        }
    }

    var escalations = await db.AuditLogs.AsNoTracking()
        .OrderByDescending(a => a.LogId)
        .Take(6)
        .Select(a => new
        {
            time = a.AuditTimestamp,
            summary = a.ComplianceStatus ?? "—"
        })
        .ToListAsync(ct);

    return Results.Ok(new
    {
        auditLogs24h = audit24h,
        auditLogs7d = audit7d,
        usersCount,
        pendingTransparency = pendingReviews,
        scoringCriteriaCount = criteriaCount,
        algorithmsCount,
        userDecisionFactorLinks = udfCount,
        seekerRoleCount = seekerCount,
        seeker,
        recentAuditSummaries = escalations
    });
});

app.MapGet("/api/seeker/job-matches", async (string? email, AppDbContext db, CancellationToken ct) =>
{
    var e = (email ?? "").Trim().ToLowerInvariant();
    if (e.Length == 0)
    {
        return Results.BadRequest(new { message = "email is required." });
    }

    var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Email.ToLower() == e, ct);
    if (user is null)
    {
        return Results.NotFound(new { message = "User not found." });
    }

    var userFactors = await (
        from udf in db.UserDecisionFactors.AsNoTracking()
        join df in db.DecisionFactors.AsNoTracking() on udf.FactorId equals df.FactorId
        where udf.UserId == user.UserId
        select new { df.AlgoId, Impact = df.ImpactScore ?? 0m }
    ).ToListAsync(ct);

    var benchRows = await db.AlgorithmBenchmarks.AsNoTracking().ToListAsync(ct);
    var benchAlgoByCriteria = benchRows
        .GroupBy(b => b.CriteriaId)
        .ToDictionary(g => g.Key, g => g.Select(x => x.AlgoId).ToHashSet());

    var criteria = await db.ScoringCriteria.AsNoTracking().OrderBy(c => c.CriteriaId).ToListAsync(ct);
    var rows = criteria.Select(c =>
    {
        benchAlgoByCriteria.TryGetValue(c.CriteriaId, out var algos);
        var algoSet = algos ?? new HashSet<int>();
        var relevant = userFactors.Where(uf => algoSet.Contains(uf.AlgoId)).ToList();
        double? match = relevant.Count > 0 ? (double)relevant.Average(x => x.Impact) : null;
        return new
        {
            c.CriteriaId,
            jobTitle = c.JobTitle ?? "—",
            requiredSkills = string.IsNullOrWhiteSpace(c.RequiredSkills) ? "—" : c.RequiredSkills,
            minExperience = c.MinExperience,
            matchScore = match
        };
    }).ToList();

    rows.Sort((a, b) => (b.matchScore ?? -1).CompareTo(a.matchScore ?? -1));
    var ranked = rows.Select((r, i) => new
    {
        rank = i + 1,
        r.CriteriaId,
        r.jobTitle,
        r.requiredSkills,
        r.minExperience,
        r.matchScore
    }).ToList();

    return Results.Ok(ranked);
});

app.MapGet("/api/user/decision-history", async (string? email, AppDbContext db, CancellationToken ct) =>
{
    var e = (email ?? "").Trim().ToLowerInvariant();
    if (e.Length == 0)
    {
        return Results.BadRequest(new { message = "email is required." });
    }

    var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Email.ToLower() == e, ct);
    if (user is null)
    {
        return Results.NotFound(new { message = "User not found." });
    }

    var rows = await db.UserDecisionFactors.AsNoTracking()
        .Where(udf => udf.UserId == user.UserId)
        .OrderByDescending(udf => udf.FactorId)
        .Select(udf => new
        {
            decisionId = $"factor-{udf.FactorId}",
            type = "Decision factor",
            subject = udf.DecisionFactor.Algorithm.ModelName,
            score = udf.DecisionFactor.ImpactScore,
            policy = udf.DecisionFactor.Algorithm.Version ?? "—"
        })
        .ToListAsync(ct);

    return Results.Ok(rows);
});

app.MapGet("/api/recruiter/decision-snapshot", async (AppDbContext db, CancellationToken ct) =>
{
    var rows = await (
        from udf in db.UserDecisionFactors.AsNoTracking()
        join u in db.Users.AsNoTracking() on udf.UserId equals u.UserId
        let df = udf.DecisionFactor
        let algo = df.Algorithm
        orderby udf.UserId, udf.FactorId
        select new
        {
            decisionId = $"factor-{udf.FactorId}-u{udf.UserId}",
            type = "Candidate factor",
            subject = u.Name + " · " + algo.ModelName,
            score = df.ImpactScore,
            policy = algo.Version ?? "—",
            algoId = df.AlgoId,
            modelName = algo.ModelName
        }
    ).Take(40).ToListAsync(ct);

    return Results.Ok(rows);
});

app.MapGet("/api/seeker/transparency-feed", async (string? email, AppDbContext db, CancellationToken ct) =>
{
    var e = (email ?? "").Trim().ToLowerInvariant();
    if (e.Length == 0)
    {
        return Results.BadRequest(new { message = "email is required." });
    }

    var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Email.ToLower() == e, ct);
    if (user is null)
    {
        return Results.NotFound(new { message = "User not found." });
    }

    var rows = await db.TransparencyPortal.AsNoTracking()
        .Where(tp => tp.UserId == user.UserId)
        .OrderByDescending(tp => tp.RequestId)
        .Select(tp => new
        {
            tp.RequestId,
            tp.RequestStatus,
            detail = tp.TierLevel ?? "—"
        })
        .ToListAsync(ct);

    return Results.Ok(rows);
});

app.Run();

public record CreateReviewRequest(string RequesterEmail, string DecisionId, string Reason, string? Notes, string? Source);

public record FormalDisputeRequest(string RequesterEmail, string DecisionId, string Reason, string? Notes);

public record ClaimReviewRequest(int RequestId, int ReviewerId);

public record ResolveReviewRequest(int RequestId, string FinalAction, string HumanJustification);

public record AddressReviewRequest(int RequestId, string? Summary);

public record EscalateReviewRequest(int RequestId);

public record EthicsEscalateRequest(int RequestId);

public record LoginRequest(string Email, string Password);

public record QuickLoginRequest(string TargetRole);

public record AppendAuditRequest(string Summary, int? UserId, int? ReviewerId, int? FactorId);

internal static class ConsultantNarrative
{
    public static List<string> TokenizeSkills(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return new List<string>();
        }

        var parts = raw.Split(
            new[] { ',', ';', '\n', '\r' },
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var result = new List<string>();
        foreach (var p in parts)
        {
            foreach (var sub in p.Split(" and ", StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (sub.Length >= 2)
                {
                    result.Add(sub.Trim());
                }
            }
        }

        return result.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }
}

internal static class UiRoleMapper
{
    public static string FromUserRole(string? userRole)
    {
        var x = (userRole ?? "").Trim().ToLowerInvariant();
        if (x.Contains("audit")) return "auditor";
        if (x == "admin") return "admin";
        if (x.Contains("recruit") || x.Contains("manager")) return "recruiter";
        return "seeker";
    }
}

internal static class ReviewRequestRouting
{
    public static string? SuggestSpecialistName(string? reason, IReadOnlyList<Reviewer> reviewers)
    {
        var r = (reason ?? "other").Trim();
        if (r.Length == 0) r = "other";
        var rLower = r.ToLowerInvariant();

        foreach (var rev in reviewers.OrderBy(x => x.ReviewerId))
        {
            var a = (rev.Attribute ?? "").Trim();
            if (a.Length == 0) continue;
            if (rLower.Contains(a, StringComparison.OrdinalIgnoreCase)) return rev.EmployeeName;
            if (a.Contains(r, StringComparison.OrdinalIgnoreCase)) return rev.EmployeeName;
        }

        foreach (var rev in reviewers.OrderBy(x => x.ReviewerId))
        {
            var a = (rev.Attribute ?? "").ToLowerInvariant();
            if (a.Length == 0) continue;
            if (rLower.Contains("incorrect") || rLower.Contains("unfair"))
            {
                if (a.Contains("fair") || a.Contains("bias") || a.Contains("compliance") || a.Contains("equity"))
                    return rev.EmployeeName;
            }

            if (rLower.Contains("missing") || rLower.Contains("context") || rLower.Contains("explain"))
            {
                if (a.Contains("technical") || a.Contains("explain") || a.Contains("policy"))
                    return rev.EmployeeName;
            }
        }

        var admin = reviewers.FirstOrDefault(x =>
            x.EmployeeName.Contains("Ravi", StringComparison.OrdinalIgnoreCase));
        return admin?.EmployeeName;
    }
}

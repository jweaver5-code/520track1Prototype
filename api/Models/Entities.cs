using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace api.Models;

[Table("users")]
public class User
{
    [Key]
    [Column("user_id")]
    public int UserId { get; set; }

    [Required, MaxLength(255)]
    [Column("name")]
    public string Name { get; set; } = string.Empty;

    [Required, MaxLength(255)]
    [Column("email")]
    public string Email { get; set; } = string.Empty;

    [Required, MaxLength(100)]
    [Column("user_role")]
    public string UserRole { get; set; } = string.Empty;

    [MaxLength(100)]
    [Column("department")]
    public string? Department { get; set; }

    [MaxLength(120)]
    [Column("job_title")]
    public string? JobTitle { get; set; }

    public ICollection<TransparencyPortal> TransparencyRequests { get; set; } = new List<TransparencyPortal>();
    public ICollection<AuditLog> AuditLogs { get; set; } = new List<AuditLog>();
    public ICollection<UserDecisionFactor> UserDecisionFactors { get; set; } = new List<UserDecisionFactor>();
    public ICollection<UserAppeal> UserAppeals { get; set; } = new List<UserAppeal>();
}

[Table("reviewers")]
public class Reviewer
{
    [Key]
    [Column("reviewer_id")]
    public int ReviewerId { get; set; }

    [Required, MaxLength(255)]
    [Column("employee_name")]
    public string EmployeeName { get; set; } = string.Empty;

    [MaxLength(100)]
    [Column("department")]
    public string? Department { get; set; }

    [MaxLength(100)]
    [Column("certification_level")]
    public string? CertificationLevel { get; set; }

    [MaxLength(255)]
    [Column("attribute")]
    public string? Attribute { get; set; }

    public ICollection<TransparencyPortal> TransparencyRequests { get; set; } = new List<TransparencyPortal>();
    public ICollection<AuditLog> AuditLogs { get; set; } = new List<AuditLog>();
}

[Table("scoring_criteria")]
public class ScoringCriteria
{
    [Key]
    [Column("criteria_id")]
    public int CriteriaId { get; set; }

    [MaxLength(255)]
    [Column("job_title")]
    public string? JobTitle { get; set; }

    [Column("required_skills")]
    public string? RequiredSkills { get; set; }

    [Column("min_experience")]
    public int? MinExperience { get; set; }

    public ICollection<AlgorithmBenchmark> AlgorithmBenchmarks { get; set; } = new List<AlgorithmBenchmark>();
    public ICollection<AlgorithmPower> AlgorithmPowers { get; set; } = new List<AlgorithmPower>();
}

[Table("algorithms")]
public class Algorithm
{
    [Key]
    [Column("algo_id")]
    public int AlgoId { get; set; }

    [Required, MaxLength(255)]
    [Column("model_name")]
    public string ModelName { get; set; } = string.Empty;

    [MaxLength(50)]
    [Column("version")]
    public string? Version { get; set; }

    [MaxLength(255)]
    [Column("vendor")]
    public string? Vendor { get; set; }

    [Column("last_audit_date", TypeName = "date")]
    public DateOnly? LastAuditDate { get; set; }

    public ICollection<DecisionFactor> DecisionFactors { get; set; } = new List<DecisionFactor>();
    public ICollection<AlgorithmBenchmark> AlgorithmBenchmarks { get; set; } = new List<AlgorithmBenchmark>();
    public ICollection<AlgorithmPower> AlgorithmPowers { get; set; } = new List<AlgorithmPower>();
}

[Table("decision_factors")]
public class DecisionFactor
{
    [Key]
    [Column("factor_id")]
    public int FactorId { get; set; }

    [Column("impact_score", TypeName = "decimal(5,2)")]
    public decimal? ImpactScore { get; set; }

    [Column("algo_id")]
    public int AlgoId { get; set; }

    [MaxLength(120)]
    [Column("factor_name")]
    public string? FactorName { get; set; }

    public Algorithm Algorithm { get; set; } = null!;
    public ICollection<AuditLog> AuditLogs { get; set; } = new List<AuditLog>();
    public ICollection<UserDecisionFactor> UserDecisionFactors { get; set; } = new List<UserDecisionFactor>();
}

[Table("transparency_portal")]
public class TransparencyPortal
{
    [Key]
    [Column("request_id")]
    public int RequestId { get; set; }

    [Required, MaxLength(50)]
    [Column("request_status")]
    public string RequestStatus { get; set; } = string.Empty;

    [MaxLength(50)]
    [Column("tier_level")]
    public string? TierLevel { get; set; }

    [Column("user_id")]
    public int UserId { get; set; }

    [Column("reviewer_id")]
    public int? ReviewerId { get; set; }

    [MaxLength(4000)]
    [Column("human_justification")]
    public string? HumanJustification { get; set; }

    [MaxLength(40)]
    [Column("request_source")]
    public string RequestSource { get; set; } = "ApplicantDispute";

    public User User { get; set; } = null!;
    public Reviewer? Reviewer { get; set; }
    public ICollection<UserAppeal> UserAppeals { get; set; } = new List<UserAppeal>();
}

[Table("audit_logs")]
public class AuditLog
{
    [Key]
    [Column("log_id")]
    public int LogId { get; set; }

    [Column("audit_timestamp")]
    public DateTime AuditTimestamp { get; set; }

    [MaxLength(50)]
    [Column("compliance_status")]
    public string? ComplianceStatus { get; set; }

    [Column("impact_ratio", TypeName = "decimal(5,2)")]
    public decimal? ImpactRatio { get; set; }

    [Column("user_id")]
    public int? UserId { get; set; }

    [Column("reviewer_id")]
    public int? ReviewerId { get; set; }

    [Column("factor_id")]
    public int? FactorId { get; set; }

    public User? User { get; set; }
    public Reviewer? Reviewer { get; set; }
    public DecisionFactor? DecisionFactor { get; set; }
}

[Table("user_decision_factors")]
public class UserDecisionFactor
{
    [Column("user_id")]
    public int UserId { get; set; }

    [Column("factor_id")]
    public int FactorId { get; set; }

    /// <summary>Candidate-specific 0–1 match on this factor (distinct from rubric weight on <see cref="DecisionFactor"/>).</summary>
    [Column("match_score", TypeName = "decimal(5,2)")]
    public decimal? MatchScore { get; set; }

    [MaxLength(2000)]
    [Column("evidence_notes")]
    public string? EvidenceNotes { get; set; }

    public User User { get; set; } = null!;
    public DecisionFactor DecisionFactor { get; set; } = null!;
}

[Table("user_appeals")]
public class UserAppeal
{
    [Key]
    [Column("appeal_id")]
    public int AppealId { get; set; }

    [Column("user_id")]
    public int UserId { get; set; }

    [Column("request_id")]
    public int RequestId { get; set; }

    [Column("appeal_date", TypeName = "date")]
    public DateOnly? AppealDate { get; set; }

    [MaxLength(4000)]
    [Column("resolution_notes")]
    public string? ResolutionNotes { get; set; }

    [MaxLength(4000)]
    [Column("appeal_notes")]
    public string? AppealNotes { get; set; }

    public User User { get; set; } = null!;
    public TransparencyPortal TransparencyPortal { get; set; } = null!;
}

[Table("algorithm_benchmarks")]
public class AlgorithmBenchmark
{
    [Column("algo_id")]
    public int AlgoId { get; set; }

    [Column("criteria_id")]
    public int CriteriaId { get; set; }

    public Algorithm Algorithm { get; set; } = null!;
    public ScoringCriteria ScoringCriteria { get; set; } = null!;
}

[Table("algorithm_powers")]
public class AlgorithmPower
{
    [Column("algo_id")]
    public int AlgoId { get; set; }

    [Column("criteria_id")]
    public int CriteriaId { get; set; }

    public Algorithm Algorithm { get; set; } = null!;
    public ScoringCriteria ScoringCriteria { get; set; } = null!;
}

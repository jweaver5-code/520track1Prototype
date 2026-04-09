using api.Models;
using Microsoft.EntityFrameworkCore;

namespace api.Data;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<Reviewer> Reviewers => Set<Reviewer>();
    public DbSet<ScoringCriteria> ScoringCriteria => Set<ScoringCriteria>();
    public DbSet<Algorithm> Algorithms => Set<Algorithm>();
    public DbSet<DecisionFactor> DecisionFactors => Set<DecisionFactor>();
    public DbSet<TransparencyPortal> TransparencyPortal => Set<TransparencyPortal>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<UserDecisionFactor> UserDecisionFactors => Set<UserDecisionFactor>();
    public DbSet<UserAppeal> UserAppeals => Set<UserAppeal>();
    public DbSet<AlgorithmBenchmark> AlgorithmBenchmarks => Set<AlgorithmBenchmark>();
    public DbSet<AlgorithmPower> AlgorithmPowers => Set<AlgorithmPower>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.Entity<User>()
            .HasIndex(u => u.Email)
            .IsUnique();

        modelBuilder.Entity<TransparencyPortal>()
            .HasOne(tp => tp.User)
            .WithMany(u => u.TransparencyRequests)
            .HasForeignKey(tp => tp.UserId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<TransparencyPortal>()
            .HasOne(tp => tp.Reviewer)
            .WithMany(r => r.TransparencyRequests)
            .HasForeignKey(tp => tp.ReviewerId)
            .OnDelete(DeleteBehavior.SetNull);

        modelBuilder.Entity<DecisionFactor>()
            .HasOne(df => df.Algorithm)
            .WithMany(a => a.DecisionFactors)
            .HasForeignKey(df => df.AlgoId)
            .OnDelete(DeleteBehavior.Restrict);

        modelBuilder.Entity<AuditLog>()
            .Property(al => al.AuditTimestamp)
            .HasDefaultValueSql("CURRENT_TIMESTAMP");

        modelBuilder.Entity<AuditLog>()
            .HasOne(al => al.User)
            .WithMany(u => u.AuditLogs)
            .HasForeignKey(al => al.UserId)
            .OnDelete(DeleteBehavior.SetNull);

        modelBuilder.Entity<AuditLog>()
            .HasOne(al => al.Reviewer)
            .WithMany(r => r.AuditLogs)
            .HasForeignKey(al => al.ReviewerId)
            .OnDelete(DeleteBehavior.SetNull);

        modelBuilder.Entity<AuditLog>()
            .HasOne(al => al.DecisionFactor)
            .WithMany(df => df.AuditLogs)
            .HasForeignKey(al => al.FactorId)
            .OnDelete(DeleteBehavior.SetNull);

        modelBuilder.Entity<UserDecisionFactor>()
            .HasKey(udf => new { udf.UserId, udf.FactorId });

        modelBuilder.Entity<UserDecisionFactor>()
            .HasOne(udf => udf.User)
            .WithMany(u => u.UserDecisionFactors)
            .HasForeignKey(udf => udf.UserId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<UserDecisionFactor>()
            .HasOne(udf => udf.DecisionFactor)
            .WithMany(df => df.UserDecisionFactors)
            .HasForeignKey(udf => udf.FactorId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<UserAppeal>()
            .HasOne(ua => ua.User)
            .WithMany(u => u.UserAppeals)
            .HasForeignKey(ua => ua.UserId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<UserAppeal>()
            .HasOne(ua => ua.TransparencyPortal)
            .WithMany(tp => tp.UserAppeals)
            .HasForeignKey(ua => ua.RequestId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<AlgorithmBenchmark>()
            .HasKey(ab => new { ab.AlgoId, ab.CriteriaId });

        modelBuilder.Entity<AlgorithmBenchmark>()
            .HasOne(ab => ab.Algorithm)
            .WithMany(a => a.AlgorithmBenchmarks)
            .HasForeignKey(ab => ab.AlgoId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<AlgorithmBenchmark>()
            .HasOne(ab => ab.ScoringCriteria)
            .WithMany(sc => sc.AlgorithmBenchmarks)
            .HasForeignKey(ab => ab.CriteriaId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<AlgorithmPower>()
            .HasKey(ap => new { ap.AlgoId, ap.CriteriaId });

        modelBuilder.Entity<AlgorithmPower>()
            .HasOne(ap => ap.Algorithm)
            .WithMany(a => a.AlgorithmPowers)
            .HasForeignKey(ap => ap.AlgoId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<AlgorithmPower>()
            .HasOne(ap => ap.ScoringCriteria)
            .WithMany(sc => sc.AlgorithmPowers)
            .HasForeignKey(ap => ap.CriteriaId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}

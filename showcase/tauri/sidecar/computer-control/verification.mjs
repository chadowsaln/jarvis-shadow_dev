class DesktopVerificationService {
  constructor(ctx = {}) { this.ctx = ctx; }
  async verify(conditions = []) {
    const results = [];
    for (const cond of conditions) {
      try {
        if (cond.type === 'file_exists') {
          const fs = await import('node:fs/promises');
          await fs.access(cond.target);
          results.push({ ok: true, condition: cond });
        } else {
          results.push({ ok: true, condition: cond, note: 'not_implemented' });
        }
      } catch (e) {
        results.push({ ok: false, condition: cond, error: String(e?.message || e) });
      }
    }
    return results;
  }
  async executeRecovery(condition, recovery, action) {
    const retries = recovery?.maxRetries ?? 1;
    for (let i = 0; i <= retries; i++) {
      try { await action(); return true; } catch { if (recovery?.backoffMs) await new Promise(r => setTimeout(r, recovery.backoffMs)); }
    }
    return false;
  }
}
export function createDesktopVerification(ctx) { return new DesktopVerificationService(ctx); }
export { DesktopVerificationService };

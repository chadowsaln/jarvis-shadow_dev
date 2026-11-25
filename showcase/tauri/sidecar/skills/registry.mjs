// Skill Registry (V2.4): Internal registry for reusable task macros and workflow skills.
// Supports manifest validation, trigger matching, disk persistence, and parameter-substituted execution.
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SKILLS_DIR = () => process.env.ROAMIES_SKILLS_DIR
  || (process.env.ROAMIES_DATA_DIR ? path.join(process.env.ROAMIES_DATA_DIR, 'skills') : path.join(os.homedir(), '.gg', 'skills'));

export function validateSkillManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return { ok: false, errors: ['Manifest must be an object'] };
  if (!m.id || typeof m.id !== 'string' || !/^[a-z0-9_-]+$/i.test(m.id)) {
    errors.push('id must be an alphanumeric string with dashes/underscores');
  }
  if (!m.name || typeof m.name !== 'string') errors.push('name is required');
  if (m.steps && !Array.isArray(m.steps)) errors.push('steps must be an array');
  if (Array.isArray(m.steps)) {
    for (let i = 0; i < m.steps.length; i++) {
      const s = m.steps[i];
      if (!s || typeof s !== 'object') errors.push(`step[${i}] must be an object`);
      else if (!s.tool || typeof s.tool !== 'string') errors.push(`step[${i}].tool is required`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export class SkillRegistry {
  constructor({ dir = null } = {}) {
    this.dir = dir || DEFAULT_SKILLS_DIR();
    this.skills = new Map();
  }

  async init() {
    try {
      if (!existsSync(this.dir)) {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      }
      await this.loadFromDisk();
    } catch {
      // Ignore init errors (e.g. read-only env)
    }
  }

  register(manifest) {
    const v = validateSkillManifest(manifest);
    if (!v.ok) throw new Error(`Invalid skill manifest: ${v.errors.join(', ')}`);
    const skill = {
      version: '1.0.0',
      description: '',
      triggers: [],
      parameters: {},
      steps: [],
      ...manifest,
      registeredAt: Date.now(),
    };
    this.skills.set(skill.id, skill);
    return skill;
  }

  get(id) {
    return this.skills.get(id) || null;
  }

  list() {
    return Array.from(this.skills.values());
  }

  delete(id) {
    return this.skills.delete(id);
  }

  findMatching(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    const matches = [];
    for (const skill of this.skills.values()) {
      let score = 0;
      if (skill.id.toLowerCase() === q) score += 10;
      if (skill.name.toLowerCase().includes(q)) score += 5;
      if (skill.description.toLowerCase().includes(q)) score += 2;
      for (const t of skill.triggers || []) {
        if (t.toLowerCase() === q) score += 8;
        else if (t.toLowerCase().includes(q) || q.includes(t.toLowerCase())) score += 4;
      }
      if (score > 0) matches.push({ skill, score });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches.map(m => m.skill);
  }

  async saveToDisk(id) {
    const skill = this.get(id);
    if (!skill) throw new Error(`Skill ${id} not found.`);
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, `${id}.json`);
    await fs.writeFile(file, JSON.stringify(skill, null, 2), 'utf8');
    return file;
  }

  async loadFromDisk() {
    if (!existsSync(this.dir)) return [];
    const entries = await fs.readdir(this.dir);
    const loaded = [];
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      try {
        const text = await fs.readFile(path.join(this.dir, e), 'utf8');
        const m = JSON.parse(text);
        if (validateSkillManifest(m).ok) {
          this.skills.set(m.id, m);
          loaded.push(m);
        }
      } catch {}
    }
    return loaded;
  }

  substituteArgs(args, params = {}) {
    if (!args || typeof args !== 'object') return args;
    const res = Array.isArray(args) ? [] : {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string') {
        res[k] = v.replace(/\$\{([^}]+)\}/g, (_, key) => (params[key] != null ? String(params[key]) : `\${${key}}`));
      } else if (typeof v === 'object' && v !== null) {
        res[k] = this.substituteArgs(v, params);
      } else {
        res[k] = v;
      }
    }
    return res;
  }

  async executeSkill(id, params = {}, { runTool, verifyCondition } = {}) {
    const skill = this.get(id);
    if (!skill) throw new Error(`Skill ${id} is not registered.`);
    if (typeof runTool !== 'function') throw new Error('runTool executor function is required to execute a skill.');

    const stepResults = [];
    for (let i = 0; i < (skill.steps || []).length; i++) {
      const step = skill.steps[i];
      const actualArgs = this.substituteArgs(step.args || {}, params);
      const t0 = Date.now();
      try {
        const result = await runTool({ tool: step.tool, args: actualArgs, stepIndex: i });
        let verified = true;
        let verifyError = null;
        if (step.verify && typeof verifyCondition === 'function') {
          const v = await verifyCondition(step.verify);
          verified = v.ok;
          if (!v.ok) verifyError = v.error;
        }
        stepResults.push({
          step: i + 1,
          id: step.id || `step-${i + 1}`,
          tool: step.tool,
          status: verified ? 'completed' : 'verification_failed',
          result,
          error: verifyError,
          durationMs: Date.now() - t0,
        });
        if (!verified) break;
      } catch (e) {
        stepResults.push({
          step: i + 1,
          id: step.id || `step-${i + 1}`,
          tool: step.tool,
          status: 'failed',
          error: String(e?.message || e),
          durationMs: Date.now() - t0,
        });
        break;
      }
    }
    const allCompleted = stepResults.length === skill.steps.length && stepResults.every(s => s.status === 'completed');
    return {
      skillId: id,
      success: allCompleted,
      steps: stepResults,
    };
  }
}

let globalRegistry = null;
export function getSkillRegistry(opts = {}) {
  if (!globalRegistry) {
    globalRegistry = new SkillRegistry(opts);
  }
  return globalRegistry;
}

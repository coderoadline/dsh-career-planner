/**
 * career-store — 职业规划数据层核心
 *
 * 唯一职责：把 workspace/career/ 下的 JSON 文件当作权威数据读写，
 * 并负责：ID 生成、去重、状态机校验、审计日志、Markdown 投影。
 *
 * 这个模块被两个消费者共用（因此刻意做成无依赖的纯 Node 模块）：
 *   1. 工作台插件的 Host 半边（通过 client host.call RPC 驱动）
 *   2. Agent 工具（经 harness.defineTool 注册）
 *
 * 设计铁律：
 *   - JSON 是权威，Markdown 是投影。任何写入后重新生成投影。
 *   - events.jsonl 只追加。
 *   - resumes/ 下的原件永不写入。
 *   - 隐式推断（source != user_explicit）不参与正式结论，除非 confirmed === true。
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, appendFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
// ⚠️ 这里**刻意不静态 import** `./tech-taxonomy.mjs`：
//   `career-store.mjs` 的一个设计性质是"单文件可拷贝"——
//   工作区里只放它一个文件就能跑（test-resolve.mjs 就是这么测的）。
//   静态 import 会让"只拷 career-store.mjs"的工作区直接 ERR_MODULE_NOT_FOUND。
//   所以词表一律走 `await import(...)` 惰性加载（见 taxonomy() / legacyHintsFor()）。

// ───────────────────────────── 常量与路径 ─────────────────────────────

/** 画像维度（固定七类，工作台按此分组） */
export const DIMENSIONS = [
  { key: 'basic', label: '基本信息' },
  { key: 'skill', label: '技能' },
  { key: 'experience', label: '经历' },
  { key: 'target', label: '目标' },
  { key: 'constraint', label: '约束' },
  { key: 'preference', label: '偏好' },
  { key: 'weakness', label: '短板自述' },
];

export const SOURCES = ['user_explicit', 'resume_parsed', 'ai_inferred'];

/**
 * 投递状态机：key → { label, rank, next[] }。
 *
 * `rank` 是流程推进的单调序号，用来做**回退保护**（用户反馈 #2）：
 *   "已经进入笔试之后的流程的时候就不能再改成已投递了，
 *    同样的二面之后就不能再改成一面了。"
 *
 * 光靠 `next[]` 不够——因为 `force:true` 能绕过去。所以额外加一层
 * rank 校验：**任何降低 rank 的流转一律拒绝**（除了 rejected/withdrawn
 * 复活这种语义上不算"回退"的特例）。
 *
 * rank 相同表示同一阶段（如 rejected/withdrawn 都是终态旁支）。
 */
export const APPLICATION_STATES = {
  wishlist: { label: '想投', rank: 0, next: ['applied', 'withdrawn'] },
  applied: { label: '已投递', rank: 10, next: ['resume_screen', 'written_test', 'interview_1', 'rejected', 'withdrawn'] },
  resume_screen: { label: '简历筛选', rank: 20, next: ['written_test', 'interview_1', 'rejected', 'withdrawn'] },
  written_test: { label: '笔试', rank: 30, next: ['interview_1', 'rejected', 'withdrawn'] },
  interview_1: { label: '一面', rank: 40, next: ['interview_2', 'rejected', 'withdrawn'] },
  interview_2: { label: '二面', rank: 50, next: ['interview_3', 'rejected', 'withdrawn'] },
  interview_3: { label: '三面', rank: 60, next: ['hr_interview', 'rejected', 'withdrawn'] },
  hr_interview: { label: 'HR 面', rank: 70, next: ['offer', 'rejected', 'withdrawn'] },
  offer: { label: '已 Offer', rank: 80, next: ['accepted', 'rejected', 'withdrawn'] },
  accepted: { label: '已接受', rank: 90, next: [] },
  rejected: { label: '已挂', rank: 100, next: ['applied'] },      // 允许被复活（换部门重投）
  withdrawn: { label: '我放弃', rank: 100, next: ['applied'] },
};

/** 可以从"终态旁支"复活回 applied 的状态（这类流转不算回退） */
export const REVIVABLE = new Set(['rejected', 'withdrawn']);

/** 是否为回退流转（会降低流程进度） */
export function isBackwardTransition(from, to) {
  const a = APPLICATION_STATES[from];
  const b = APPLICATION_STATES[to];
  if (!a || !b) return false;
  if (REVIVABLE.has(from) && to === 'applied') return false;  // 复活不算回退
  return b.rank < a.rank;
}

/**
 * 技能状态只有两种（v1.5.3）。
 *
 *   learning 在学    —— 默认态。含"还没开始考"和"考了几次没过"两种情形，
 *                      没必要拆成「待学 / 在学 / 考核中」三档：用户视角里
 *                      「已通过之前都还是在学」，拆开反而要纠结该点哪个。
 *   done     已通过  —— **只能由考核通过产生**（见 recordExam / updateSkill 的硬约束）。
 *
 * 没有「考核中」是因为考核是对话里即时发生的，中间态没有展示价值。
 * 没有「已通过 → 手动改回在学」是因为那会绕开铁律：未通过只由考核判定。
 */
export const SKILL_STATUS = {
  learning: { label: '在学' },
  done: { label: '已通过' },
};

/** 技能难度 → 建议学习基准天数（排期器使用） */
export const DIFFICULTY_DAYS = { easy: 7, medium: 21, hard: 45 };

// ───────────────────────────── 基础工具 ─────────────────────────────

const nowIso = () => new Date().toISOString();

/**
 * 简历解析产物的文件名：**去掉原后缀**再加 .md。
 *   简历.pdf  →  简历.md      （不是 简历.pdf.md）
 *
 * ⚠️ 同名不同后缀会撞车（简历.docx 与 简历.pdf 都想叫 简历.md），
 * 这种情况由调用方加短哈希区分，函数本身保持纯粹的"去后缀"。
 */
function mdNameFor(resumeName) {
  return `${String(resumeName).replace(/\.[^.]+$/, '')}.md`;
}


function pad(n, w = 2) { return String(n).padStart(w, '0'); }

/** 本地日期 YYYY-MM-DD */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shortId(prefix) {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const txt = await readFile(file, 'utf8');
    if (!txt.trim()) return structuredClone(fallback);
    const parsed = JSON.parse(txt);
    return parsed ?? structuredClone(fallback);
  } catch (err) {
    if (err && err.code === 'ENOENT') return structuredClone(fallback);
    // JSON 损坏：不抛错吞掉数据，而是备份后返回 fallback，让上层能修复
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      await writeFile(backup, await readFile(file, 'utf8'), 'utf8');
    } catch { /* 备份失败不阻塞主流程 */ }
    const e = new Error(`数据文件损坏，已备份到 ${backup}：${err.message}`);
    e.code = 'CORRUPT_JSON';
    throw e;
  }
}

async function writeJsonAtomic(file, value) {
  await ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  // Windows 上 rename 到已存在文件会失败，先删目标
  try {
    const { rename, unlink } = await import('node:fs/promises');
    try { await unlink(file); } catch { /* 目标不存在也正常 */ }
    await rename(tmp, file);
  } catch {
    await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
  }
}

// ───────────────────────────── CareerStore ─────────────────────────────

export class CareerStore {
  /**
   * @param {string} workspaceRoot 会话工作区根目录
   */
  constructor(workspaceRoot) {
    this.root = resolve(workspaceRoot, 'career');
  }

  // ---- 路径 ----
  get paths() {
    return {
      root: this.root,
      profile: join(this.root, 'profile', 'profile.json'),
      profileMd: join(this.root, 'profile', 'profile.md'),
      jobs: join(this.root, 'jobs', 'jobs.json'),
      jobsMd: join(this.root, 'jobs', 'jobs.md'),
      applications: join(this.root, 'applications', 'applications.json'),
      skills: join(this.root, 'skills', 'skills.json'),
      graph: join(this.root, 'graph', 'skill-graph.json'),
      resumes: join(this.root, 'resumes'),
      events: join(this.root, 'logs', 'events.jsonl'),
    };
  }

  /** 建立目录骨架与空数据文件（幂等） */
  async init() {
    const p = this.paths;
    for (const d of ['profile', 'jobs', 'applications', 'skills', 'graph', 'resumes', 'logs']) {
      await ensureDir(join(this.root, d));
    }
    for (const [file, fallback] of [
      [p.profile, emptyProfile()],
      [p.jobs, emptyJobs()],
      [p.applications, emptyApplications()],
      [p.skills, emptySkills()],
    ]) {
      if (!existsSync(file)) await writeJsonAtomic(file, fallback);
    }
    if (!existsSync(join(p.resumes, 'README.md'))) {
      await writeFile(join(p.resumes, 'README.md'),
        '# 简历原件目录\n\n把你上传的简历放在这里（PDF / DOCX / MD / TXT）。\n'
        + '**这里的文件永不被本系统修改。** 解析结果写到 `<文件名>.parsed.txt`。\n', 'utf8');
    }
    // ⚠️ 这里**只能**调 syncProjections（生成 .md），绝不能调 syncMarkdown：
    //    syncMarkdown → syncDerived → readJobs → init → 回到这里 → 无限递归。
    //    （本会话真踩过：init 卡死 120s 超时，查了半天是这条环。）
    await this.syncProjections();
    return this.paths;
  }

  // ── 审计日志 ──
  /**
   * 追加一条审计记录。任何写操作都必须调用它。
   * @param {{actor:'user'|'ai', action:string, entity:string, entityId?:string,
   *          field?:string, before?:*, after?:*, confirmed?:boolean, note?:string}} entry
   */
  async log(entry) {
    const line = JSON.stringify({
      at: nowIso(),
      actor: entry.actor,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      field: entry.field ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      confirmed: entry.confirmed ?? true,
      note: entry.note ?? null,
    });
    await ensureDir(dirname(this.paths.events));
    await appendFile(this.paths.events, line + '\n', 'utf8');
  }

  async readEvents(limit = 200) {
    try {
      const txt = await readFile(this.paths.events, 'utf8');
      const lines = txt.split('\n').filter(Boolean);
      return lines.slice(-limit).map((l) => {
        try { return JSON.parse(l); } catch { return { raw: l, parseError: true }; }
      }).reverse();
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  // ─────────────────────── 画像 ───────────────────────

  async readProfile() {
    await this.init();
    const data = await readJson(this.paths.profile, emptyProfile());
    if (!Array.isArray(data.tags)) data.tags = [];
    return data;
  }

  /**
   * 新增画像标签。
   * @param {{dimension:string,label:string,value:string,evidence?:string,
   *          source:string,confidence?:string}} input
   * @param {{actor?:'user'|'ai',confirmed?:boolean}} ctx
   */
  async addProfileTag(input, ctx = {}) {
    const actor = ctx.actor ?? 'ai';
    if (!DIMENSIONS.some((d) => d.key === input.dimension)) {
      throw new Error(`未知画像维度：${input.dimension}（可用：${DIMENSIONS.map((d) => d.key).join(', ')}）`);
    }
    if (!input.label || !String(input.label).trim()) throw new Error('画像标签 label 不能为空');
    const source = SOURCES.includes(input.source) ? input.source : 'ai_inferred';
    const data = await this.readProfile();

    // 同维度同 label 视为同一条：改为更新而非重复插入
    const exist = data.tags.find(
      (t) => t.dimension === input.dimension && String(t.label).toLowerCase() === String(input.label).toLowerCase()
    );
    if (exist) {
      return this.updateProfileTag(exist.id, {
        value: input.value, evidence: input.evidence, source, confidence: input.confidence,
      }, ctx);
    }

    const tag = {
      id: shortId('tag'),
      dimension: input.dimension,
      label: String(input.label).trim(),
      value: input.value == null ? '' : String(input.value),
      evidence: input.evidence ? String(input.evidence) : '',
      source,
      confidence: input.confidence || 'medium',
      // 隐式来源默认未确认；user_explicit 视为天然确认
      confirmed: source === 'user_explicit' ? true : (ctx.confirmed === true),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    data.tags.push(tag);
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.profile, data);
    await this.log({ actor, action: 'create', entity: 'profile_tag', entityId: tag.id, after: tag, confirmed: tag.confirmed });
    await this.syncMarkdown();
    return tag;
  }

  async updateProfileTag(id, patch, ctx = {}) {
    const actor = ctx.actor ?? 'ai';
    const data = await this.readProfile();
    const tag = data.tags.find((t) => t.id === id);
    if (!tag) throw new Error(`画像标签不存在：${id}`);
    const before = structuredClone(tag);
    for (const k of ['label', 'value', 'evidence', 'source', 'confidence', 'dimension']) {
      if (patch[k] !== undefined) tag[k] = patch[k];
    }
    if (ctx.confirmed === true) tag.confirmed = true;
    if (ctx.confirmed === false) tag.confirmed = false;
    // 改回 user_explicit 视为人工确认
    if (tag.source === 'user_explicit') tag.confirmed = true;
    tag.updatedAt = nowIso();
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.profile, data);
    await this.log({
      actor, action: 'update', entity: 'profile_tag', entityId: id,
      before, after: tag, confirmed: ctx.confirmed ?? true,
    });
    await this.syncMarkdown();
    return tag;
  }

  async deleteProfileTag(id, ctx = {}) {
    const data = await this.readProfile();
    const i = data.tags.findIndex((t) => t.id === id);
    if (i < 0) throw new Error(`画像标签不存在：${id}`);
    const [removed] = data.tags.splice(i, 1);
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.profile, data);
    await this.log({ actor: ctx.actor ?? 'ai', action: 'delete', entity: 'profile_tag', entityId: id, before: removed });
    await this.syncMarkdown();
    return removed;
  }

  async setProfileObjective(text, ctx = {}) {
    const data = await this.readProfile();
    const before = data.objective ?? '';
    data.objective = String(text ?? '');
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.profile, data);
    await this.log({ actor: ctx.actor ?? 'ai', action: 'update', entity: 'profile', field: 'objective', before, after: data.objective });
    await this.syncMarkdown();
    return data.objective;
  }

  /** 只返回已确认标签（正式分析用） */
  async confirmedTags() {
    const data = await this.readProfile();
    return data.tags.filter((t) => t.confirmed === true);
  }

  // ─────────────────────── JD 池 ───────────────────────

  async readJobs() {
    await this.init();
    const data = await readJson(this.paths.jobs, emptyJobs());
    if (!Array.isArray(data.items)) data.items = [];
    return data;
  }

  /**
   * 写入 JD（带去重）。返回 { item, isNew, updated }。
   * 去重键：url（非空时）否则 company|title|city。
   */
  /**
   * 写入/更新一条 JD。
   *
   * ⚠️ v1.5.1：**支持内联标签** `input.tags`。
   * Agent 录 JD 时本来就已经读过正文了，所以标签应当**跟着这次写入一起给**，
   * 不该再逼它多调一次 `tag_job`。带了 tags 就在这里同步落库 + 进词表；
   * 没带才退回 `applyTags()`（只解析已有的 aiTags / businessSkills，不猜）。
   *
   * `input.tags` 刻意**不放进 `normalizeJob`**：那个函数是字段白名单，
   * 会把未知字段静默丢掉（查过才确认的，否则标签会莫名其妙消失）。
   */
  /**
   * 写入/更新一条 JD。
   *
   * ★ v1.5.1：**技能关键词就是标签，录一次就到位。**
   * `skills`（编辑栏那个字段）与 `tags` 在这里是同一个东西的两种写法：
   *   · 传了 `tags` → 以它为准（会回写进 `skills`，两边永远一致）；
   *   · 只传 `skills` → 直接按 skills 打标；
   *   · 都没传 → 不动已有标签。
   * 所以 Agent 录 JD **不需要再单独调一次 `tag_job`** —— 它读正文时判断出的
   * 方向，写进 skills 就完事了。
   *
   * ⚠️ `input.tags` 必须在 `normalizeJob` **之前**取：normalizeJob 是字段白名单，
   * 会把未知字段静默丢掉（查过才确认的，否则标签会莫名消失）。
   */
  async upsertJob(input, ctx = {}) {
    const actor = ctx.actor ?? 'ai';
    if (!input.company || !input.title) throw new Error('JD 必须包含 company 与 title');
    // 标签来源：tags 优先，其次 skills（两者等价，tags 只是显式写法）
    const tagSource = (Array.isArray(input.tags) && input.tags.length)
      ? input.tags
      : ((Array.isArray(input.skills) && input.skills.length) ? input.skills : null);
    if (Array.isArray(input.tags) && input.tags.length > MAX_TECH_PER_JOB) {
      throw new Error(`标签最多 ${MAX_TECH_PER_JOB} 个（用户要求：不要强行凑满），当前给了 ${input.tags.length} 个`);
    }
    const data = await this.readJobs();
    const key = (j) => jobKey(j);
    const incoming = normalizeJob(input);
    const k = key(incoming);
    const exist = data.items.find((j) => key(j) === k);

    if (exist) {
      const before = structuredClone(exist);
      const beforeTags = JSON.stringify(exist.businessSkills || []);
      // 只在有实际变化时刷新 updatedAt
      let changed = false;
      for (const f of ['description', 'requirements', 'city', 'url', 'source', 'status', 'salary']) {
        if (incoming[f] && incoming[f] !== exist[f]) { exist[f] = incoming[f]; changed = true; }
      }
      if (Array.isArray(incoming.skills) && incoming.skills.length) {
        const merged = Array.from(new Set([...(exist.skills || []), ...incoming.skills]));
        if (merged.length !== (exist.skills || []).length) { exist.skills = merged; changed = true; }
      }

      // ★ 两种标签来源，语义不同，**不能混为一谈**：
      //   · `tags`   ＝ "这就是这条 JD 的方向" → **整体替换**（AI 的一次判断），按 1~5 截断
      //   · `skills` ＝ 采集/人工往关键词里**追加**了几条 → **合并**后重新投影，不截断
      // 早先我让 skills 也走"替换"，结果重复采集（只回传 K8s）会悄悄吃掉已有的
      // Go/Redis/MySQL —— 采集路径必须是合并语义。
      if (Array.isArray(input.tags) && input.tags.length) {
        await this.stampTags(exist, input.tags, { actor, jobId: exist.id });
      } else if (Array.isArray(exist.skills) && exist.skills.length) {
        await this.stampTags(exist, exist.skills, {
          actor, jobId: exist.id, capAt: 0, writeSkills: false,
        });
        // 同上：writeSkills:false 时把对象形态的 skills 展平为标签名，避免对象落进 JSON
        const flat = (exist.aiTags || []).map((t) => t.label);
        if (flat.length) exist.skills = flat;
      } else if (changed && Array.isArray(exist.aiTags) && exist.aiTags.length) {
        // 正文变了但这次没给任何标签 → 旧标签不再可信
        this.invalidateTags(exist, '岗位内容已更新，原标签待重打标');
      }
      // 标签投影后没变，就别把这次算成"更新"（否则重复采集会刷一片 updatedAt）
      if (JSON.stringify(exist.businessSkills || []) !== beforeTags) changed = true;

      if (changed) {
        exist.updatedAt = nowIso();
        data.updatedAt = nowIso();
        await writeJsonAtomic(this.paths.jobs, data);
        await this.log({ actor, action: 'update', entity: 'job', entityId: exist.id, before, after: exist, note: '去重命中，更新已有条目' });
        await this.syncMarkdown();
      }
      return { item: exist, isNew: false, updated: changed, tagged: !!tagSource };
    }

    const item = { ...incoming, id: incoming.id || shortId('jd'), collectedAt: nowIso(), updatedAt: nowIso() };
    if (Array.isArray(input.tags) && input.tags.length) {
      await this.stampTags(item, input.tags, { actor, jobId: item.id });
    } else if (item.skills && item.skills.length) {
      await this.stampTags(item, item.skills, { actor, jobId: item.id, capAt: 0, writeSkills: false });
      // ⚠️ writeSkills:false 意味着 skills 保持原样 —— 若传入的是 {label,aliases} 对象，
      // 它会以对象形态留在 JSON 里，而 UI/筛选/Markdown 都按字符串数组消费它。
      // 标签（aiTags）已由 stampTags 正确落库，这里把 skills 展平成标签名，两边一致。
      item.skills = (item.aiTags || []).map((t) => t.label);
    } else {
      // 没给关键词：保持空标签，界面显示「待 AI 分析」（不自己猜）
      item.aiTags = [];
      item.businessSkills = [];
    }
    data.items.push(item);
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.jobs, data);
    await this.log({ actor, action: 'create', entity: 'job', entityId: item.id, after: item });
    await this.syncMarkdown();
    return { item, isNew: true, updated: false, tagged: !!tagSource };
  }

  /** 正文变更但没有新标签时：作废旧标签，别让旧标签冒充新内容的标签 */
  invalidateTags(job, reason = '岗位内容已修改，原标签作废，需重新打标') {
    job.aiTags = [];
    job.businessSkills = [];
    job.skills = [];
    job.tagLang = undefined;
    job.tagLowConfidence = false;
    job.needsRetag = true;
    job.needsRetagReason = reason;
    delete job.taggedAt;
    delete job.taggedBy;
  }

  /** 批量写入，返回统计 */
  async upsertJobs(list, ctx = {}) {
    const result = { created: 0, updated: 0, unchanged: 0, items: [] };
    for (const j of list) {
      const r = await this.upsertJob(j, ctx);
      result.items.push(r.item);
      if (r.isNew) result.created += 1;
      else if (r.updated) result.updated += 1;
      else result.unchanged += 1;
    }
    return result;
  }

  async updateJob(id, patch, ctx = {}) {
    const data = await this.readJobs();
    const item = data.items.find((j) => j.id === id);
    if (!item) throw new Error(`JD 不存在：${id}`);
    const before = structuredClone(item);
    for (const f of ['company', 'title', 'city', 'description', 'requirements', 'url', 'source', 'status', 'salary', 'excluded', 'excludedReason']) {
      if (patch[f] !== undefined) item[f] = patch[f];
    }
    if (Array.isArray(patch.skills)) item.skills = normalizeSkillList(patch.skills);
    // ★ 「技能关键词」就是这条 JD 的标签（v1.5.1 统一语义）。
    // 所以用户在编辑栏改 skills ＝ 直接改标签，立刻重新投影到 aiTags / businessSkills。
    const patchTags = (Array.isArray(patch.tags) && patch.tags.length) ? patch.tags : null;
    if (patchTags) {
      await this.stampTags(item, patchTags, { actor: ctx.actor, jobId: id });
    } else if (Array.isArray(patch.skills)) {
      if (patch.skills.length) {
        await this.retagFromSkills(item, { actor: ctx.actor ?? 'user', jobId: id });
      } else {
        // 关键词被清空 = 标签清空，界面显示「待 AI 分析」
        this.invalidateTags(item, '技能关键词已被清空');
      }
    } else {
      // 只改了正文、没碰关键词 → 旧标签不再可信
      const CONTENT_FIELDS = ['title', 'requirements', 'description'];
      const contentChanged = CONTENT_FIELDS.some((f) =>
        JSON.stringify(item[f] ?? null) !== JSON.stringify(before[f] ?? null));
      if (contentChanged && Array.isArray(item.aiTags) && item.aiTags.length) {
        this.invalidateTags(item);
      } else {
        applyTags(item);
      }
    }
    // 用户手动改过就留痕，避免被"采集更新"覆盖时说不清
    if (ctx.actor === 'user') item.editedByUser = true;
    item.updatedAt = nowIso();
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.jobs, data);
    await this.log({
      actor: ctx.actor ?? 'ai', action: 'update', entity: 'job', entityId: id,
      before, after: item, note: ctx.actor === 'user' ? '用户在界面修改' : undefined,
    });
    await this.syncMarkdown();
    return item;
  }

  async deleteJob(id, ctx = {}) {
    const data = await this.readJobs();
    const i = data.items.findIndex((j) => j.id === id);
    if (i < 0) throw new Error(`JD 不存在：${id}`);
    const [removed] = data.items.splice(i, 1);
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.jobs, data);
    await this.log({ actor: ctx.actor ?? 'ai', action: 'delete', entity: 'job', entityId: id, before: removed });
    await this.syncMarkdown();
    return removed;
  }

  /**
   * 按公司 / 岗位关键词 / 城市聚合，供工作台分类视图。
   *
   * ⚠️ `excluded` 的 JD 不计入**任何**统计（方向热度、公司分布、城市分布）。
   * 典型场景：届别不符、岗位类型不符（如只做算法岗却混进运营岗）——
   * 这类岗位对用户不可投，但它的方向标签会污染「这个方向热不热」的判断，
   * 让用户以为某方向机会很多，其实那些机会他一个都投不了。
   *
   * 用独立的 `excluded` 字段而不是复用 `status`：`status` 会被
   * `expireStaleJobs()`（15 天自动过期）和 `recordLinkCheck()`（链接复检复活）
   * 改写，用它承载"不可投"语义会被那些流程覆盖掉。
   */
  async jobBuckets() {
    const { items: allItems } = await this.readJobs();
    const items = allItems.filter((j) => j.excluded !== true);
    const byCompany = new Map();
    const byCity = new Map();
    for (const j of items) {
      const c = j.company || '未知公司';
      const city = j.city || '未知城市';
      byCompany.set(c, (byCompany.get(c) || 0) + 1);
      byCity.set(city, (byCity.get(city) || 0) + 1);
    }
    // 技能词频（从 JD 自带 skills 字段）
    const skillFreq = new Map();
    for (const j of items) {
      for (const s of normalizeSkillList(j.skills)) skillFreq.set(s, (skillFreq.get(s) || 0) + 1);
    }
    // 技术标签词频（v1.5：标签来自大模型打标，展示名/颜色查词表）
    const tagMeta = await this.tagMeta();
    const bizFreq = new Map();
    for (const j of items) {
      const ids = Array.isArray(j.businessSkills) && j.businessSkills.length
        ? j.businessSkills
        : extractTechTags(j).map((b) => b.id);
      for (const id of ids) bizFreq.set(id, (bizFreq.get(id) || 0) + 1);
    }
    const tagFreq = [...bizFreq].map(([k, v]) => {
      const meta = tagMeta.get(k);
      return {
        key: k, id: k,
        label: (meta && meta.label) || techLabel(k),
        hue: (meta && typeof meta.hue === 'number' ? meta.hue : techHue(k)),
        group: (meta && meta.group) || (TECH_BY_ID.get(k) ? TECH_BY_ID.get(k).group : null),
        count: v,
      };
    }).sort((a, b) => b.count - a.count);
    return {
      total: items.length,
      byCompany: [...byCompany].map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count),
      byCity: [...byCity].map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count),
      skillFreq: [...skillFreq].map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count),
      // 唯一的标签词频（带颜色，前端气泡直接用）
      tagFreq,
      // 兼容 v1.1 读法
      bizFreq: tagFreq,
    };
  }

  /**
   * 找出「超过 N 天没更新」的 JD（需求 2 / v1.2 需求 9）。
   *
   * v1.2 语义调整（用户反馈 #9）：
   *   "过了15天自动过期，检测失效就是检测所有过期的网站还能不能被访问到"
   * 所以这里返回的是**该被标记为过期**的 JD，调用方应直接调用
   * `expireStaleJobs()` 让它们进入 expired 状态，而不是只做检测。
   *
   * @param {number} days 天数阈值，默认 15
   */
  async staleJobs(days = 15) {
    const { items } = await this.readJobs();
    const cutoff = Date.now() - days * 86400_000;
    return items.filter((j) => {
      if (j.status === 'expired' || j.status === 'pending_delete') return false;
      const t = Date.parse(j.updatedAt || j.collectedAt || '');
      return Number.isFinite(t) && t < cutoff;
    });
  }

  /**
   * 把超过 N 天没更新的 JD 批量标记为「已过期」（需求 9）。
   * 这一步**不需要联网**，纯按时间判定，可以在打开工作台时自动执行。
   *
   * @param {number} days 天数阈值
   * @returns {{expired:number, ids:string[]}}
   */
  async expireStaleJobs(days = 15, ctx = {}) {
    const stale = await this.staleJobs(days);
    if (!stale.length) return { expired: 0, ids: [] };
    const data = await this.readJobs();
    const ids = [];
    for (const s of stale) {
      const item = data.items.find((j) => j.id === s.id);
      if (!item) continue;
      item.status = 'expired';
      item.expiredReason = `超过 ${days} 天未更新，自动标记为已过期`;
      item.expiredAt = nowIso();
      ids.push(item.id);
    }
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.jobs, data);
    await this.log({
      actor: ctx.actor ?? 'ai', action: 'auto-expire', entity: 'job',
      note: `${ids.length} 条 JD 超过 ${days} 天未更新，自动标记为已过期`,
      after: { ids },
    });
    await this.syncMarkdown();
    return { expired: ids.length, ids };
  }

  /**
   * 记录一次链接存活检测结果（需求 2 / v1.2 需求 9）。
   *
   * v1.2 流程：只检测 expired 的 JD →
   *   - 能访问 → 复活为 active（说明岗位还在）
   *   - 不能访问 → 标记 `pending_delete`（待删除），并记下 `pendingDeleteAt`
   *   - 无法确认（403/429/超时）→ 保持 expired，不进入待删除
   *     因为反爬导致的 403 不代表岗位下线，误删代价太高
   *
   * @param {string} id JD id
   * @param {{alive:boolean|null, httpStatus?:number, note?:string}} result
   */
  async recordLinkCheck(id, result, ctx = {}) {
    const data = await this.readJobs();
    const item = data.items.find((j) => j.id === id);
    if (!item) throw new Error(`JD 不存在：${id}`);
    const before = structuredClone(item);
    item.lastCheckedAt = nowIso();
    item.linkAlive = result.alive === true ? true : result.alive === false ? false : null;
    item.linkHttpStatus = result.httpStatus ?? null;

    if (result.alive === true) {
      // 还能访问 → 复活，并重置 15 天计时（因为刚确认过有效）
      item.status = 'active';
      delete item.expiredReason;
      delete item.expiredAt;
      delete item.pendingDeleteAt;
      item.updatedAt = nowIso();
    } else if (result.alive === false) {
      // 确认不可访问 → 待删除（用户要求：标记待删除，一天后删掉）
      item.status = 'pending_delete';
      item.pendingDeleteAt = nowIso();
      item.expiredReason = result.note || `链接不可访问（HTTP ${result.httpStatus ?? '无响应'}）`;
    } else {
      // 无法确认 → 保持原状态，不动
      item.status = item.status === 'pending_delete' ? 'expired' : item.status;
    }

    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.jobs, data);
    await this.log({
      actor: ctx.actor ?? 'ai', action: 'link-check', entity: 'job', entityId: id,
      before: { status: before.status, linkAlive: before.linkAlive },
      after: { status: item.status, linkAlive: item.linkAlive },
      note: result.note || (result.alive === true ? '链接存活，已复活' : result.alive === false ? '链接失效，标记待删除' : '无法确认，保持原状'),
    });
    await this.syncMarkdown();
    return item;
  }

  /**
   * 列出「待删除」且已超过宽限期的 JD（需求 9：标记待删除，一天后删掉）。
   * @param {number} graceDays 宽限天数，默认 1
   */
  async pendingDeleteJobs(graceDays = 1) {
    const { items } = await this.readJobs();
    const cutoff = Date.now() - graceDays * 86400_000;
    return items.filter((j) => {
      if (j.status !== 'pending_delete') return false;
      const t = Date.parse(j.pendingDeleteAt || '');
      return Number.isFinite(t) && t < cutoff;
    });
  }

  /**
   * 清理到期该删除的 JD（需求 9）。由工作台打开时或定时调用。
   * @param {number} graceDays 宽限天数
   */
  async purgePendingDelete(graceDays = 1, ctx = {}) {
    const doomed = await this.pendingDeleteJobs(graceDays);
    if (!doomed.length) return { purged: 0, ids: [], titles: [] };
    const data = await this.readJobs();
    const ids = [];
    const titles = [];
    for (const d of doomed) {
      const i = data.items.findIndex((j) => j.id === d.id);
      if (i < 0) continue;
      ids.push(d.id);
      titles.push(`${d.company} · ${d.title}`);
      data.items.splice(i, 1);
    }
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.jobs, data);
    await this.log({
      actor: ctx.actor ?? 'ai', action: 'purge', entity: 'job',
      note: `自动删除了 ${ids.length} 条确认失效且超过 ${graceDays} 天宽限期的 JD`,
      before: { items: titles },
    });
    await this.syncMarkdown();
    return { purged: ids.length, ids, titles };
  }

  /**
   * 撤销「待删除」标记（用户可在界面上救回误判的 JD）。
   */
  async restoreJob(id, ctx = {}) {
    const data = await this.readJobs();
    const item = data.items.find((j) => j.id === id);
    if (!item) throw new Error(`JD 不存在：${id}`);
    const before = structuredClone(item);
    item.status = 'active';
    delete item.pendingDeleteAt;
    delete item.expiredReason;
    delete item.expiredAt;
    item.updatedAt = nowIso();
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.jobs, data);
    await this.log({
      actor: ctx.actor ?? 'user', action: 'restore', entity: 'job', entityId: id,
      before: { status: before.status }, after: { status: 'active' },
      note: '用户恢复了被标记待删除的 JD',
    });
    await this.syncMarkdown();
    return item;
  }

  // ─────────────────────── 投递 ───────────────────────

  async readApplications() {
    await this.init();
    const data = await readJson(this.paths.applications, emptyApplications());
    if (!Array.isArray(data.items)) data.items = [];
    return data;
  }

  async addApplication(input, ctx = {}) {
    const actor = ctx.actor ?? 'ai';
    const data = await this.readApplications();
    let status = input.status || 'wishlist';
    if (!APPLICATION_STATES[status]) throw new Error(`未知投递状态：${status}`);

    // 若引用 JD，则从 JD 补齐公司/岗位，避免重复录入
    let company = input.company;
    let title = input.title;
    if (input.jobId) {
      const jobs = await this.readJobs();
      const job = jobs.items.find((j) => j.id === input.jobId);
      if (job) { company = company || job.company; title = title || job.title; }
    }
    if (!company || !title) throw new Error('投递必须包含 company 与 title（或提供有效 jobId）');

    const dup = data.items.find(
      (a) => a.company === company && a.title === title
    );
    if (dup) throw new Error(`该投递已存在（id=${dup.id}，当前状态 ${dup.status}），请改用更新接口`);

    const item = {
      id: shortId('app'),
      jobId: input.jobId || null,
      company,
      title,
      status,
      note: input.note || '',
      timeline: [{ at: today(), status, note: input.note || '创建投递记录', actor }],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    data.items.push(item);
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.applications, data);
    await this.log({ actor, action: 'create', entity: 'application', entityId: item.id, after: item });
    return item;
  }

  /**
   * 变更投递状态（含状态机校验 + 回退保护）。timeline 只追加。
   *
   * 两层校验：
   *   1. `next[]` 白名单——只允许合法推进；
   *   2. **rank 单调性**——即使 force，也不允许把已到笔试的退回已投递（用户反馈 #2）。
   *      想纠正误操作请用 `undoApplicationStatus`（用户反馈 #3）。
   *
   * @param {boolean} ctx.force 跳过 next[] 白名单（例如跳级：已投递 → 直接一面）
   */
  async setApplicationStatus(id, status, note, ctx = {}) {
    const actor = ctx.actor ?? 'ai';
    const data = await this.readApplications();
    const item = data.items.find((a) => a.id === id);
    if (!item) throw new Error(`投递记录不存在：${id}`);
    const def = APPLICATION_STATES[status];
    if (!def) throw new Error(`未知投递状态：${status}`);
    if (status === item.status) return item;

    // ── 回退保护：优先级高于 force，force 也不能倒退 ──
    if (isBackwardTransition(item.status, status)) {
      const from = APPLICATION_STATES[item.status];
      throw new Error(
        `不能把投递状态从「${from.label}」改回「${def.label}」：流程只允许向前推进。`
        + `如果刚才是误操作，请使用「撤销」退回上一步。`
      );
    }

    const cur = APPLICATION_STATES[item.status];
    const allowed = cur ? cur.next : [];
    if (!allowed.includes(status) && ctx.force !== true) {
      const allowedLabels = allowed.map((s) => `${s}(${APPLICATION_STATES[s].label})`).join('、') || '无';
      throw new Error(
        `非法状态流转：${item.status}(${cur ? cur.label : '?'}) → ${status}(${def.label})。`
        + `允许的下一状态：${allowedLabels}。若确需跳转，请让调用方传 force=true。`
      );
    }
    const before = structuredClone(item);
    // 记录 from，供撤销使用（撤销时要知道退回到哪）
    item.timeline.push({
      at: today(), status, from: item.status, note: note || '', actor,
      forced: ctx.force === true ? true : undefined,
    });
    item.status = status;
    if (note) item.note = note;
    item.updatedAt = nowIso();
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.applications, data);
    await this.log({
      actor, action: 'update', entity: 'application', entityId: id,
      field: 'status', before: before.status, after: status, confirmed: ctx.confirmed ?? true, note,
    });
    return item;
  }

  /**
   * 撤销上一次状态变更（用户反馈 #3：「防止误触后无法撤销更新过的投递状态」）。
   *
   * 做法：取 timeline 最后一条**状态变更**记录，用它的 `from` 回退。
   * 若该记录没有 `from`（v1.1 及更早写入的旧数据），则往上找最近一条
   * 带 `from` 的，或退回到 timeline 里倒数第二个状态。
   *
   * 撤销本身也写审计日志，并在 timeline 上追加一条 `undo` 记录——
   * 这样 timeline 依然是只追加的，历史不会被抹掉。
   */
  async undoApplicationStatus(id, ctx = {}) {
    const actor = ctx.actor ?? 'ai';
    const data = await this.readApplications();
    const item = data.items.find((a) => a.id === id);
    if (!item) throw new Error(`投递记录不存在：${id}`);
    if (!Array.isArray(item.timeline) || item.timeline.length < 2) {
      throw new Error('没有可撤销的状态变更（该投递只有一条初始记录）');
    }

    // 从后往前找最近一条"变更了状态"的记录
    let idx = -1;
    for (let i = item.timeline.length - 1; i >= 1; i--) {
      const t = item.timeline[i];
      if (t.status && t.status !== 'undo') { idx = i; break; }
    }
    if (idx < 0) throw new Error('没有可撤销的状态变更');

    const last = item.timeline[idx];
    // 优先用记录的 from；旧数据没有 from 时，回退到该条之前的状态
    let target = last.from;
    if (!target) {
      for (let i = idx - 1; i >= 0; i--) {
        if (item.timeline[i].status && item.timeline[i].status !== 'undo') {
          target = item.timeline[i].status;
          break;
        }
      }
    }
    if (!target || !APPLICATION_STATES[target]) {
      throw new Error('无法确定要撤销到的状态（历史记录缺少来源状态），请手动设置');
    }
    if (target === item.status) throw new Error('当前状态与上一步一致，无需撤销');

    const before = item.status;
    item.status = target;
    item.timeline.push({
      at: today(), status: 'undo', from: before, to: target, actor,
      note: `撤销：${APPLICATION_STATES[before].label} → ${APPLICATION_STATES[target].label}`,
    });
    item.updatedAt = nowIso();
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.applications, data);
    await this.log({
      actor, action: 'undo', entity: 'application', entityId: id,
      field: 'status', before, after: target,
      note: `撤销上一次状态变更（${APPLICATION_STATES[before].label} → ${APPLICATION_STATES[target].label}）`,
    });
    return item;
  }

  async updateApplication(id, patch, ctx = {}) {
    const data = await this.readApplications();
    const item = data.items.find((a) => a.id === id);
    if (!item) throw new Error(`投递记录不存在：${id}`);
    const before = structuredClone(item);
    for (const f of ['company', 'title', 'jobId', 'note']) {
      if (patch[f] !== undefined) item[f] = patch[f];
    }
    item.updatedAt = nowIso();
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.applications, data);
    await this.log({ actor: ctx.actor ?? 'ai', action: 'update', entity: 'application', entityId: id, before, after: item });
    return item;
  }

  async deleteApplication(id, ctx = {}) {
    const data = await this.readApplications();
    const i = data.items.findIndex((a) => a.id === id);
    if (i < 0) throw new Error(`投递记录不存在：${id}`);
    const [removed] = data.items.splice(i, 1);
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.applications, data);
    await this.log({ actor: ctx.actor ?? 'ai', action: 'delete', entity: 'application', entityId: id, before: removed });
    return removed;
  }

  // ─────────────────────── 技能清单 ───────────────────────

  async readSkills() {
    await this.init();
    const data = await readJson(this.paths.skills, emptySkills());
    if (!Array.isArray(data.items)) data.items = [];
    return data;
  }

  /**
   * 新增技能。proposedBy=ai 时必须给 reason（依据），否则拒绝。
   * 截止日由排期器计算并说明理由。
   */
  async addSkill(input, ctx = {}) {
    const actor = ctx.actor ?? 'ai';
    const data = await this.readSkills();
    const name = String(input.name || '').trim();
    if (!name) throw new Error('技能名称不能为空');
    if (input.proposedBy === 'ai' && !input.reason) {
      throw new Error('AI 提议技能必须提供 reason（依据），否则不允许写入');
    }
    const dup = data.items.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (dup) throw new Error(`技能已存在：${dup.name}（id=${dup.id}，状态 ${dup.status}）`);

    // 用户手动加的技能词也进标签词表（用户要求：词表不只由打标长大）。
    // 失败不能挡住加技能，所以吞掉异常只记一行日志。
    try {
      await this.addTaxonomyTerm(name, { actor: ctx.actor ?? 'user', origin: 'user' });
    } catch (err) {
      console.warn('[career] 技能词进标签词表失败（不影响加技能）：', err && err.message);
    }

    const difficulty = ['easy', 'medium', 'hard'].includes(input.difficulty) ? input.difficulty : 'medium';
    const schedule = this.scheduleFor(difficulty, data.items);
    const item = {
      id: shortId('sk'),
      name,
      status: input.status && SKILL_STATUS[input.status] ? input.status : 'learning',
      difficulty,
      proposedBy: input.proposedBy === 'ai' ? 'ai' : 'user',
      reason: input.reason || '',
      startDate: input.startDate || null,
      targetDate: input.targetDate || schedule.targetDate,
      targetDateReason: input.targetDate ? '用户/调用方指定' : schedule.reason,
      exams: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    data.items.push(item);
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.skills, data);
    await this.log({ actor, action: 'create', entity: 'skill', entityId: item.id, after: item, confirmed: ctx.confirmed ?? true });
    return item;
  }

  /**
   * 排期器：根据难度基准 + 当前在学/待学数量，给出建议截止日与理由。
   */
  scheduleFor(difficulty, existing = []) {
    const base = DIFFICULTY_DAYS[difficulty] ?? 21;
    const pending = existing.filter((s) => s.status === 'learning').length;
    // 每多一个未完成技能，顺延 30%（线性抢占注意力，而非简单叠加）
    const factor = 1 + pending * 0.3;
    const days = Math.max(3, Math.round(base * factor));
    const d = new Date();
    d.setDate(d.getDate() + days);
    const targetDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const reason = `难度=${difficulty}（基准 ${base} 天）`
      + `，当前未完成技能 ${pending} 个（系数 ×${factor.toFixed(1)}）`
      + `，故建议 ${days} 天后（${targetDate}）完成。`;
    return { targetDate, days, reason };
  }

  async updateSkill(id, patch, ctx = {}) {
    const data = await this.readSkills();
    const item = data.items.find((s) => s.id === id);
    if (!item) throw new Error(`技能不存在：${id}`);
    const before = structuredClone(item);
    for (const f of ['name', 'difficulty', 'reason', 'startDate', 'targetDate', 'targetDateReason']) {
      if (patch[f] !== undefined) item[f] = patch[f];
    }
    if (patch.status !== undefined) {
      if (!SKILL_STATUS[patch.status]) throw new Error(`未知技能状态：${patch.status}`);
      // 铁律：只有通过考核才能标记"已通过"
      if (patch.status === 'done' && !item.exams.some((e) => e.passed)) {
        throw new Error('技能不能直接标记为已通过：必须先通过一次考核（exams 中至少一条 passed=true）');
      }
      // 反向同理：已通过也不能手动改回在学 —— 那会绕开铁律。
      // 未通过只由 recordExam 判定。
      if (patch.status === 'learning' && item.status === 'done') {
        throw new Error('已通过的技能不能手动改回在学：未通过由考核结果判定');
      }
      item.status = patch.status;
    }
    item.updatedAt = nowIso();
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.skills, data);
    await this.log({ actor: ctx.actor ?? 'ai', action: 'update', entity: 'skill', entityId: id, before, after: item, confirmed: ctx.confirmed ?? true });
    return item;
  }

  async deleteSkill(id, ctx = {}) {
    const data = await this.readSkills();
    const i = data.items.findIndex((s) => s.id === id);
    if (i < 0) throw new Error(`技能不存在：${id}`);
    const [removed] = data.items.splice(i, 1);
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.skills, data);
    await this.log({ actor: ctx.actor ?? 'ai', action: 'delete', entity: 'skill', entityId: id, before: removed });
    return removed;
  }

  /**
   * 记录一次考核。passed=true 时才允许标记已通过。
   *
   * v1.5.3：`items` 存**每次答题情况**（题面 / 你的答案 / AI 的点评），
   * `advice` 存整体建议。界面只显示考核记录，所以这两样必须由 Agent 在
   * `record_exam` 时一并写进来 —— 系统自己不生成题、也不判分。
   *
   * @param {{score:number, passed:boolean, items?:Array<{q?:string,answer?:string,feedback?:string}>,
   *          weakPoints?:string[], advice?:string}} exam
   */
  async recordExam(id, exam, ctx = {}) {
    const data = await this.readSkills();
    const item = data.items.find((s) => s.id === id);
    if (!item) throw new Error(`技能不存在：${id}`);
    if (typeof exam.passed !== 'boolean') throw new Error('exam.passed 必须是布尔值');
    const record = {
      at: nowIso(),
      score: Number(exam.score) || 0,
      passed: exam.passed,
      // 难度一并记下来：以后回看这次考核时知道当时按哪个标准出的题
      difficulty: item.difficulty,
      questions: Array.isArray(exam.questions) ? exam.questions : [],
      items: (Array.isArray(exam.items) ? exam.items : []).map((x) => ({
        q: String(x && x.q || ''),
        answer: String(x && x.answer || ''),
        feedback: String(x && x.feedback || ''),
      })),
      weakPoints: Array.isArray(exam.weakPoints) ? exam.weakPoints : [],
      advice: exam.advice || '',
    };
    item.exams.push(record);
    // 通过 → 已通过；未通过 → **状态不动**（本来就是在学），
    // 只把截止日按新的排期往后推。未通过不改变状态，是因为 v1.5.3 之后
    // 「在学」已经涵盖"没考过"和"考过没过"，再单独标一个状态没有意义。
    if (exam.passed) {
      item.status = 'done';
    } else {
      const s = this.scheduleFor(item.difficulty, data.items.filter((x) => x.id !== item.id));
      item.targetDate = s.targetDate;
      item.targetDateReason = `上次考核未通过，重新排期：${s.reason}`;
    }
    item.updatedAt = nowIso();
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.skills, data);
    await this.log({ actor: ctx.actor ?? 'ai', action: 'exam', entity: 'skill', entityId: id, after: record, note: exam.passed ? '通过' : '未通过' });
    return item;
  }

  /** 找出到期未完成、且未在考核中的技能（用于到期提醒） */
  async dueSkills(dateStr = today()) {
    const data = await this.readSkills();
    return data.items.filter(
      (s) => s.status !== 'done' && s.targetDate && s.targetDate <= dateStr
    );
  }

  // ─────────────────────── 技能图谱 ───────────────────────

  async readGraph() {
    return readJson(this.paths.graph, emptyGraph());
  }

  /**
   * 从 JD 池重算技能图谱。纯粹派生，可反复重算不破坏原始数据。
   *
   * v1.2（用户反馈 #11）：**技术栈与业务能力合并为一层 `tech` 节点**。
   *   用户原话："技术栈也就是业务能力，不要分开"。
   *   所以图谱里只有一种技能节点，标签来自 TECH_TAGS（带 label / group / hue），
   *   每条 JD 最多 MAX_TECH_PER_JOB 个。
   *
   * 同时产出 `tagIndex`：标签 id → { label, hue, group, count, jobIds }，
   *   前端用它渲染"彩色气泡 + 点击筛选出相关 JD"，无需自己再算一遍。
   */
  async buildGraph(ctx = {}) {
    const data = await this.readJobs();
    const items = data.items || [];
    const nodes = new Map(); // key → node
    const edges = new Map(); // `${from}|${to}|${type}` → edge

    const addNode = (id, type, label, group, hue) => {
      if (!nodes.has(id)) {
        nodes.set(id, {
          id, type, label, group: group || null,
          hue: typeof hue === 'number' ? hue : null,
          count: 0, sources: [],
        });
      }
      return nodes.get(id);
    };
    const addEdge = (from, to, type, jobId) => {
      const k = `${from}|${to}|${type}`;
      if (!edges.has(k)) edges.set(k, { from, to, type, weight: 0, jobIds: [] });
      const e = edges.get(k);
      e.weight += 1;
      if (jobId && !e.jobIds.includes(jobId)) e.jobIds.push(jobId);
    };

    // 标签索引：id → 汇总信息（前端气泡用）
    const tagIndex = new Map();
    // 活词表（大模型加的词在这里）—— 解析展示名与颜色
    const tagMeta = await this.tagMeta();

    for (const j of items) {
      const jobNode = addNode(`job:${j.id}`, 'job', `${j.company} · ${j.title}`);
      jobNode.count += 1;
      const compNode = addNode(`company:${j.company}`, 'company', j.company);
      compNode.count += 1;
      addEdge(compNode.id, jobNode.id, 'hires_for', j.id);

      // 统一的「技术 / 业务能力」标签层（v1.5：标签由大模型给，最多 5 个）
      const tags = extractTechTags(j);
      j.businessSkills = tags.map((b) => b.id);   // 回写便于界面展示与筛选
      for (const b of tags) {
        // 展示名/颜色/分组优先查活词表（大模型加的新词在里面），
        // 查不到再退回旧预置表，最后才是"标签名哈希出稳定颜色"
        const meta = tagMeta.get(b.id);
        const label = b.label || (meta && meta.label) || techLabel(b.id);
        const hue = typeof b.hue === 'number' ? b.hue
          : (meta && typeof meta.hue === 'number' ? meta.hue : techHue(b.id));
        const group = b.group || (meta && meta.group) || TECH_BY_ID.get(b.id)?.group || null;
        const tn = addNode(`tech:${b.id}`, 'tech', label, group, hue);
        tn.count += 1;
        if (!tn.sources.includes(j.id)) tn.sources.push(j.id);
        addEdge(tn.id, jobNode.id, 'requires_tech', j.id);
        addEdge(tn.id, compNode.id, 'needed_at', j.id);

        if (!tagIndex.has(b.id)) {
          tagIndex.set(b.id, { id: b.id, label, group, hue, count: 0, jobIds: [] });
        }
        const ti = tagIndex.get(b.id);
        ti.count += 1;
        if (!ti.jobIds.includes(j.id)) ti.jobIds.push(j.id);
      }
    }

    const byType = (t) => [...nodes.values()].filter((n) => n.type === t);
    // 兼容旧字段名（skill），但来源统一为 tech 节点
    const rank = (arr) => arr.sort((a, b) => b.count - a.count).map((n) => ({
      skill: n.label,
      id: n.id.replace(/^(tech|skill|biz):/, ''),
      group: n.group,
      // ★ 用节点自己算好的 hue，**不要再查 TECH_BY_ID**：
      // v1.5.1 词表是开放的，大模型/用户加的新词不在预置表里，
      // 查表会得到 null → 图谱页的彩色进度条整片失色（节点上有颜色，排名列表却丢了）。
      // 节点的 hue 在 addNode 时已经按"预置表优先、否则标签名哈希"定好了。
      hue: typeof n.hue === 'number' ? n.hue : techHue(n.id.replace(/^tech:/, '')),
      count: n.count,
      share: items.length ? +(n.count / items.length * 100).toFixed(1) : 0,
    }));

    const ranked = rank(byType('tech')).slice(0, 60);
    const graph = {
      version: 3,
      generatedAt: nowIso(),
      basedOnJobs: items.length,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      // 唯一的技能排名（技术栈与业务能力已合并）
      topTech: ranked,
      // 兼容 v1.1 的读取方（预设工具/旧前端）
      topBusinessSkills: ranked,
      topSkills: [],
      // 标签索引：前端彩色气泡 + 点击筛选
      tagIndex: [...tagIndex.values()].map((t) => ({
        ...t,
        share: items.length ? +(t.count / items.length * 100).toFixed(1) : 0,
      })).sort((a, b) => b.count - a.count),
    };
    await buildGraphFile(this.paths.graph, graph);
    await this.log({
      actor: ctx.actor ?? 'ai', action: 'rebuild', entity: 'skill_graph',
      note: `基于 ${items.length} 条 JD 重算：技术标签 ${byType('tech').length} 个（技术栈与业务能力已合并）`,
    });
    return graph;
  }

  /**
   * 重算所有 JD 的业务标签（v1.2 迁移用）。
   *
   * 背景：v1.1 之前录入的 JD 没有 `businessSkills` 字段，或带有旧分类法的 id。
   * 词表升级后需要重跑一遍抽取。这个方法是**幂等**的，可以随时调用。
   *
   * ⚠️ v1.5 语义变更：打标交给大模型后，这个方法**不再凭空猜标签**，只做两件事：
   *   ① 把 `businessSkills` 与 `aiTags` 对齐（修历史脏数据）；
   *   ② 报告哪些 JD **还没有标签**（`pending`），供界面提示"待 AI 分析"、
   *      供 Agent 决定该给哪几条补打标。
   *
   * @returns {{scanned:number, changed:number, pending:number, pendingIds:string[]}}
   */
  async recomputeJobTags(ctx = {}) {
    const data = await this.readJobs();
    let changed = 0;
    const pendingIds = [];
    for (const j of data.items) {
      const tags = extractTechTags(j);
      const next = tags.map((b) => b.id);
      const prev = Array.isArray(j.businessSkills) ? j.businessSkills : [];
      const nextLang = tags.length ? tags[0].lang : undefined;
      const nextLow = tags.length > 0 && tags.every((t) => t.lowConfidence === true);
      if (!next.length) pendingIds.push(j.id);
      // 语言 / 低置信也要一起比对，否则这类变化不会落盘
      if (next.length !== prev.length || next.some((x, i) => x !== prev[i])
        || j.tagLang !== nextLang || j.tagLowConfidence !== nextLow) {
        j.businessSkills = next;
        j.tagLang = nextLang;
        j.tagLowConfidence = nextLow;
        changed += 1;
      }
    }
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.jobs, data);
    if (changed) {
      await this.log({
        actor: ctx.actor ?? 'ai', action: 'recompute-tags', entity: 'job',
        note: `对齐了 ${changed} 条 JD 的技术标签；仍待打标 ${pendingIds.length} 条`,
      });
      await this.syncMarkdown();
    }
    return {
      scanned: data.items.length, changed,
      pending: pendingIds.length, pendingIds,
    };
  }

  /**
   * ★ 写盘后统一收敛派生数据（v1.5.2）。
   *
   * 为什么要有这个：以前"图谱/词表计数"要点「重算」才更新，于是出现两类问题：
   *   · 新加的岗位要等用户手点，图谱才是新的（滞后）；
   *   · `resolveOrCreate` 每调一次就把 count +1，同一批 JD 反复打标会把计数虚增
   *     （用户真实数据里出现过 count=5 但只挂在 1 条 JD 上）。
   * 现在每次写完都顺手跑一遍，界面就不需要人肉触发了。
   *
   * 做三件事：
   *   ① **修引用**：`businessSkills` 里指向不存在词条的 id，
   *      若 JD 自己的 `aiTags` 还留着这个词的名字 → 按原名把词条补回词表（不丢数据）；
   *      两边都没有 → 才丢掉这个引用。
   *      这一步同时消除了界面上的 `tag-177f81c1` 之类内部编号：
   *      那正是"引用悬空 → 查不到名字 → 只能显示 id"的产物。
   *   ② 重算词表 count（= 有多少条 JD 在用它，不是被调用过几次）；
   *   ③ 重建图谱。
   *
   * @param {object} [ctx]
   * @returns {Promise<{healed:number,dropped:number,graph:object}>}
   */
  async syncDerived(ctx = {}) {
    const data = await this.readJobs();
    const tx = await this.taxonomy();
    const tax = await tx.read();
    const known = new Map(tax.terms.map((t) => [t.id, t]));
    let healed = 0, dropped = 0;

    for (const j of data.items) {
      const byId = new Map((j.aiTags || []).map((t) => [t.id, t]));
      const keep = [];
      for (const id of (j.businessSkills || [])) {
        if (known.has(id)) { keep.push(id); continue; }
        const own = byId.get(id);
        if (own && own.label) {
          // 引用没了但 JD 自己还存着名字 → 用原名补回词条，比删掉更诚实
          const r = await tx.ensureTermWithId({
            id, label: own.label, hue: own.hue, lang: own.lang, origin: 'agent',
          });
          if (r.created) { known.set(id, r.term); healed += 1; }
          keep.push(id);
        } else {
          dropped += 1;
        }
      }
      j.businessSkills = keep;
      // 让每条 JD 都自带展示文字：界面不再需要回查词表，也就不会再漏出编号
      j.aiTags = (j.aiTags || []).filter((t) => keep.includes(t.id));
    }

    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.jobs, data);
    await tx.recomputeCounts(data.items);          // ② 计数改为"几条 JD 在用它"
    const graph = await this.buildGraph(ctx);      // ③ 图谱自动重建
    return { healed, dropped, graph };
  }

  /**
   * v1.5.1 语义对齐：让 `skills` 与标签**真正成为同一份东西**。
   *
   * 背景：v1.5 期间两者可以各填各的，所以用户真实数据里出现了两种不一致：
   *   · 老 JD：有 5 个人工/AI 凝练过的 aiTags，但 skills 还是抓取来的一堆原始关键词
   *     （含"编程能力""数据分析"这种噪声）；
   *   · 新录入：只有一长串 skills，没有任何标签 → 图谱与筛选拿不到东西。
   *
   * 规则（谁更可信谁赢）：
   *   1. 有 `aiTags` → 那是判断过的方向，**用它的名字覆盖 skills**；
   *   2. 只有 `skills` → 按 skills **登记进词表并投影出标签**
   *      （不截断；`normalizeTerm` 会剥掉尾部括号补充，所以以后模型写短形式也能命中）；
   *   3. 两个都空 → 保持空，界面显示「待 AI 分析」，交给 Agent 补标。
   *
   * 幂等，可反复运行。
   *
   * @returns {Promise<{scanned:number, alignedFromTags:number, stampedFromSkills:number, empty:number}>}
   */
  async reconcileTagsAndSkills(ctx = {}) {
    const { looksLikeTerm } = await import('./tech-taxonomy.mjs');
    const data = await this.readJobs();
    let alignedFromTags = 0, stampedFromSkills = 0, empty = 0;
    const junk = [];
    for (const j of data.items) {
      const rawTags = (j.aiTags || []).map((t) => (typeof t === 'string' ? t : t.label)).filter(Boolean);
      // ★ 纠错：上一轮把整句要求当标签登记过的（aiTags 里全是句子），
      // 这里把它退回"待打标"状态，而不是当成"已有标签"跳过。
      // 否则"优先复用"会在下一轮把这些句子推荐给模型，噪声就固化了。
      const tagLabels = rawTags.filter((x) => looksLikeTerm(x));
      if (rawTags.length && !tagLabels.length) {
        j.aiTags = [];
        j.businessSkills = [];
        j.tagLang = undefined;
        delete j.taggedAt;
        delete j.taggedBy;
        j.needsRetag = true;
        j.needsRetagReason = '原标签是整句要求而非方向词，已退回待 AI 重新判断';
      }
      if (tagLabels.length) {
        // ① 标签可信 → 用它们覆盖抓取来的噪声关键词。
        //    ⚠️ **不要再 stampTags 一遍**：aiTags 本来就从词表来，重复登记
        //    会把 count 越加越大，"这个方向有几条 JD"就失真了（幂等性测试抓到的）。
        const before = JSON.stringify(j.skills || []);
        j.skills = tagLabels;
        if (JSON.stringify(j.skills) !== before) alignedFromTags += 1;
        if (!(j.businessSkills || []).length) {
          await this.stampTags(j, tagLabels, {
            actor: ctx.actor ?? 'system', jobId: j.id, capAt: 0,
          });
        }
        continue;
      }
      // ② 只有关键词 → **只登记像方向词的那些**。
      // 抓来的 JD 常把整句要求塞进 skills（"NLP / CV / ML 基础"、
      // "顶会论文或大模型项目主导经验"）。全量登记会污染词表，
      // 而"优先复用"一生效就把噪声固化 —— 所以句子不登记，交回 Agent 判断。
      const clean = (j.skills || []).filter((x) => looksLikeTerm(x));
      const dirty = (j.skills || []).filter((x) => !looksLikeTerm(x));
      if (dirty.length) junk.push({ id: j.id, title: j.title, items: dirty });
      if (clean.length) {
        await this.stampTags(j, clean, { actor: ctx.actor ?? 'system', jobId: j.id, capAt: 0 });
        stampedFromSkills += 1;
      } else {
        // 一个像样的方向词都没有 → 保持无标签，界面显示「待 AI 分析」。
        // skills 原样留着：那是用户/采集填的东西，删它不在本次职权内。
        j.aiTags = [];
        j.businessSkills = [];
        empty += 1;
        // 只有"确实填了东西但都是句子"才标成待重判；
        // 完全空白的（刚手动录入）不该被说成"标签已过期"。
        if (dirty.length) {
          j.needsRetag = true;
          j.needsRetagReason = '原关键词是整句要求而非方向词，待 AI 重新判断';
        }
      }
    }
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.jobs, data);

    // 把误登记的"句子词"从词表里清掉。
    // ⚠️ 必须先重算引用：上面的纠错已经解除了 JD 对这些词的引用，
    // 但词表里的 count 还是旧值，直接判 count 会把它们当成"仍在用"而留下。
    const tx = await this.taxonomy();
    await tx.recomputeCounts(data.items);
    const all = await tx.list();
    let pruned = 0;
    for (const t of all) {
      if (!looksLikeTerm(t.label)) { await tx.removeTerm(t.id); pruned += 1; }
    }

    if (alignedFromTags || stampedFromSkills || pruned) {
      await this.log({
        actor: ctx.actor ?? 'system', action: 'reconcile-tags', entity: 'job',
        note: `对齐「技能关键词＝标签」：${alignedFromTags} 条按已有标签覆盖关键词，`
          + `${stampedFromSkills} 条把方向词登记为标签，${empty} 条待打标`
          + (pruned ? `，清掉 ${pruned} 个误登记的句子词` : ''),
      });
      await this.syncMarkdown();
    }
    return {
      scanned: data.items.length, alignedFromTags, stampedFromSkills, empty, pruned, junk,
    };
  }

  /**
   * v1.5 迁移：把历史 JD 已有的 `businessSkills` 转写成 `aiTags` 结构。
   *
   * 为什么要转：切换到大模型打标后，`aiTags` 是"已打标"的凭据。
   * 历史数据里已经有可信的标签（当年用关键词表算的、或人工确认过的），
   * 不转写的话它们会被算成"待打标"，白花一次 token，而且词表也接不上。
   *
   * 幂等：已经转写过的（aiTags 非空）会跳过。
   *
   * @returns {Promise<{scanned:number, converted:number, skipped:number}>}
   */
  async migrateLegacyTags(ctx = {}) {
    const data = await this.readJobs();
    const meta = await this.tagMeta();
    let converted = 0, skipped = 0;
    for (const j of data.items) {
      if (Array.isArray(j.aiTags) && j.aiTags.length) { skipped += 1; continue; }
      if (!(Array.isArray(j.businessSkills) && j.businessSkills.length)) { skipped += 1; continue; }
      j.aiTags = j.businessSkills.map((id) => {
        const m = meta.get(id) || {};
        return {
          id,
          label: m.label || id,
          labelZh: m.label || id,
          labelEn: m.labelEn || m.label || id,
          lang: j.tagLang || 'zh',
        };
      });
      j.taggedBy = 'migrated';
      converted += 1;
    }
    if (converted) {
      data.updatedAt = nowIso();
      await writeJsonAtomic(this.paths.jobs, data);
      await this.log({
        actor: ctx.actor ?? 'system', action: 'migrate-tags', entity: 'job',
        note: `把 ${converted} 条 JD 的历史标签转写成 aiTags 结构（v1.5 切换到大模型打标）`,
      });
      await this.syncMarkdown();
    }
    return { scanned: data.items.length, converted, skipped };
  }

  /**
   * 用历史 JD 里**实际用到**的标签给词表播种（保留旧 id 与人工调好的颜色）。
   * @returns {Promise<{scanned:number, created:number}>}
   */
  async seedTaxonomyFromJobs() {
    const { items } = await this.readJobs();
    const tx = await this.taxonomy();
    const legacy = new Map(TECH_TAGS.map((t) => [t.id, t]));
    return tx.seedFromJobs(items, legacy);
  }

  /**
   * 列出还没有技术标签的 JD —— Agent 批量打标的输入，也是界面「待 AI 分析」的来源。
   * @param {number} [limit]
   */
  async pendingTagging(limit = 100) {
    const { items } = await this.readJobs();
    return items.filter((j) => !(Array.isArray(j.businessSkills) && j.businessSkills.length))
      .slice(0, limit)
      .map((j) => ({
        id: j.id, company: j.company, title: j.title, city: j.city, url: j.url,
        needsRetag: j.needsRetag === true,
        needsRetagReason: j.needsRetagReason,
        // 兜底建议：仅作为**提示**给 Agent 参考，不直接落库
        suggestions: suggestTechTags(j).map((t) => t.label),
      }));
  }

  // ─────────────────── 大模型打标（v1.5 核心） ───────────────────

  /**
   * 惰性拿到词表实例（避免构造 CareerStore 时就读盘）。
   * @returns {Promise<import('./tech-taxonomy.mjs').TechTaxonomy>}
   */
  async taxonomy() {
    if (!this._taxonomy) {
      const { TechTaxonomy } = await import('./tech-taxonomy.mjs');
      this._taxonomy = await new TechTaxonomy(dirname(this.root)).init();
    }
    return this._taxonomy;
  }

  /**
   * 标签元数据：id → {label, hue, group, lang}
   *
   * 合并两个来源，**活词表优先**（它代表大模型实际在用的词），
   * 查不到再退回旧的预置表（历史 id 的展示元数据）。
   *
   * @returns {Promise<Map<string,{label:string,hue:number|null,group:string|null,lang:string}>>}
   */
  async tagMeta() {
    const m = new Map();
    for (const t of TECH_TAGS) {
      m.set(t.id, { label: t.label, hue: t.hue, group: t.group, lang: 'zh' });
    }
    try {
      const tx = await this.taxonomy();
      for (const t of await tx.list()) {
        const aliases = t.aliases || [];
        // 英文名不单独存字段：词表里"非中文的那个别名"就是它的英文叫法
        const en = (t.aliases || []).find((a) => !/[\u4e00-\u9fff]/.test(a));
        m.set(t.id, {
          label: t.label,
          labelEn: en || t.label,
          hue: typeof t.hue === 'number' ? t.hue : techHue(t.label),
          group: t.group || (TECH_BY_ID.get(t.id) ? TECH_BY_ID.get(t.id).group : null),
          lang: t.lang || 'zh',
          origin: t.origin,
          count: t.count || 0,
          aliases,
        });
      }
    } catch (e) {
      // 词表读不到不应该让整个图谱挂掉 —— 退回预置表即可
      console.warn('[career] 词表读取失败，退回预置表：', e && e.message);
    }
    return m;
  }

  /**
   * 给一组"模型给的标签"补充预置表的元数据（id / 人工调好的 hue / group / 英文名）。
   *
   * 为什么需要：词表刻意**不预装**那 53 条（用户要求"从 0 开始长大"），
   * 但历史 JD 的 `businessSkills` 里存的就是那些 id，而且它们的 hue 是人工调过、
   * 保证互不撞色的。所以只有当某个词**真的被用到**时，才按原 id 落进词表。
   *
   * 匹配顺序：先按 id，再按归一化 label / en 名。
   *
   * ⚠️ 刻意用 `async` + 惰性 `import` 取 normalizeTerm（而不是静态 import），
   * 为的是保住 `career-store.mjs` 的"单文件可拷贝"性质。
   */
  async withLegacyHints(candidates) {
    const { normalizeTerm } = await import('./tech-taxonomy.mjs');
    if (!this._legacyNorm) {
      const byNorm = new Map();
      for (const t of TECH_TAGS) {
        for (const k of [t.id, t.label, t.en, ...(t.aliases || [])]) {
          const n = normalizeTerm(k);
          if (n && !byNorm.has(n)) byNorm.set(n, t);
        }
      }
      this._legacyNorm = byNorm;
    }
    const byNorm = this._legacyNorm;
    return (candidates || []).map((c) => {
      const raw = typeof c === 'string' ? { label: c } : { ...c };
      // ⚠️ 必须把候选自带的 aliases 也拿来查表：
      // 模型常写 { label:'智能体强化学习', aliases:['Agent RL'] } —— 它的本意是
      // "我知道词表里有 Agent RL，我用中文说法"。
      // 只查 label 的话这条会落到新词，别名机制在最该生效的场景下失效。
      let hit = (raw.id && byNorm.get(normalizeTerm(raw.id)))
        || byNorm.get(normalizeTerm(raw.label));
      if (!hit) {
        for (const a of (raw.aliases || [])) {
          hit = byNorm.get(normalizeTerm(a));
          if (hit) break;
        }
      }
      if (!hit) return raw;
      return {
        ...raw,
        id: raw.id || hit.id,
        // 命中预置词时以预置名为准，但保留模型的说法当别名
        label: hit.label,
        hue: hit.hue,
        group: hit.group,
        labelZh: hit.label,
        labelEn: hit.en || hit.label,
        aliases: [...new Set([
          ...(raw.aliases || []),
          raw.label,          // ← 「智能体强化学习」被记成 Agent RL 的别名
          hit.label,
          hit.en,
        ].filter(Boolean))].filter((a) => normalizeTerm(a) !== normalizeTerm(hit.label)),
      };
    });
  }

  /**
   * 把一组标签**解析并盖到 job 对象上**（不落盘、不记日志）。
   *
   * ★ v1.5.1 语义统一：**编辑栏的「技能关键词」就是这条 JD 的技术标签**，
   * 不再是两个各填各的字段。以前的毛病是：
   *   · `skills`（编辑栏「技能关键词」，自由文本）
   *   · `businessSkills`（彩色气泡、图谱统计、点击筛选都读它）
   * 用户改了前者，后者不动 → 界面与图谱对不上。
   * 现在 `skills` 是**唯一入口**，`aiTags` / `businessSkills` 是它的派生投影
   * （词表 id + 中英名 + 颜色），由这个函数同步刷新，不可能再漂移。
   *
   * 于是录入 JD 只需一次写入：Agent 把判断好的方向直接写进 `skills`
   * （等价地也接受 `tags`，会被当成 skills），不需要再单独调 `tag_job`。
   *
   * @param {object} job 会被就地修改
   * @param {Array<string|{id?:string,label:string,aliases?:string[]}>} tags
   * @param {{actor?:string,jobId?:string,capAt?:number,writeSkills?:boolean}} [ctx]
   *   · `capAt`：AI 写入按"最多 5 个"截断（用户要求不凑满）；
   *     用户手填传 `0` 表示**不截断** —— 他打了 8 个就是要 8 个，悄悄丢 3 个更糟。
   *   · `writeSkills`：默认 true，把标签名回写进 `skills`，让两边永远一致。
   */
  async stampTags(job, tags, ctx = {}) {
    let list = (tags || [])
      .map((t) => (typeof t === 'string' ? { label: String(t).trim() } : t))
      .filter((t) => t && String(t.label || '').trim());
    const cap = typeof ctx.capAt === 'number' ? ctx.capAt : MAX_TECH_PER_JOB;
    if (cap > 0 && list.length > cap) list = list.slice(0, cap);

    if (!list.length) {
      // 空标签 → 清掉派生字段，界面据此显示「待 AI 分析」
      job.aiTags = [];
      job.businessSkills = [];
      job.tagLang = undefined;
      delete job.taggedAt;
      delete job.taggedBy;
      return { resolved: [], created: [] };
    }

    const lang = detectLang([job.title, job.requirements, job.description]
      .filter(Boolean).join('\n'));
    const tx = await this.taxonomy();
    // 先补预置表元数据：历史 id 保号、AI/技术词沿用人工调好的颜色
    const enriched = await this.withLegacyHints(list);
    const r = await tx.resolveOrCreate(enriched, {
      origin: ctx.actor === 'user' ? 'user' : 'agent',
      lang,
      jobId: ctx.jobId || job.id,
    });

    // 派生投影
    job.aiTags = r.resolved.map((x) => ({
      id: x.id, label: x.label, labelZh: x.label, labelEn: x.label, lang,
    }));
    job.businessSkills = r.resolved.map((x) => x.id);
    // ★ 回写 skills：「技能关键词」= 这条 JD 的标签，同一份东西
    if (ctx.writeSkills !== false) job.skills = r.resolved.map((x) => x.label);
    job.tagLang = lang;
    job.tagLowConfidence = false;   // 明确给过标签，不算兜底推断
    job.taggedAt = nowIso();
    job.taggedBy = ctx.actor ?? 'ai';
    // 打上标即视为已处理
    delete job.needsRetag;
    delete job.needsRetagReason;
    return r;
  }

  /**
   * 用户在编辑栏改「技能关键词」＝直接改标签，重新投影一遍。
   * 刻意不截断（capAt:0）：手打几个就是几个。
   */
  async retagFromSkills(job, ctx = {}) {
    return this.stampTags(job, job.skills || [], { capAt: 0, ...ctx });
  }

  /**
   * 给一条 JD **单独补打标**（不动正文）。
   *
   * ⚠️ v1.5.1 定位：这**不是**录入 JD 的主路径。
   * 主路径是 `upsert_jobs` / `update_job` 时把方向直接写进 `skills`
   * （或等价的 `tags`），一次写入就到位。
   * 这个入口只服务两种情况：
   *   ① 工作台手动录入、但「技能关键词」留空的 JD（那条路上没有模型）；
   *   ② 正文被改动导致标签作废后，Agent 重新读一遍再标。
   *
   * 流程：
   *   1. 校验 JD 存在、标签非空（每条至少 1 个）；
   *   2. 交给词表 `resolveOrCreate` —— **优先复用已有词**，
   *      只有描述不了这条 JD 时才加新词（抑制同义词分裂）；
   *   3. `stampTags` 同步刷新 `skills` / `aiTags` / `businessSkills` / `tagLang`。
   *
   * @param {string} jobId
   * @param {Array<{id?:string,label:string,aliases?:string[]}>} tags 模型输出的标签
   * @param {{actor?:string, reason?:string}} [ctx]
   * @returns {Promise<{job:object, tags:Array, created:string[], reused:number}>}
   */
  async tagJob(jobId, tags, ctx = {}) {
    const data = await this.readJobs();
    const job = data.items.find((j) => j.id === jobId);
    if (!job) throw new Error(`找不到这条 JD：${jobId}`);
    if (!Array.isArray(tags) || !tags.length) {
      throw new Error('标签不能为空：至少给 1 个（用户要求每条 JD 至少 1 个技能点）');
    }

    const r = await this.stampTags(job, tags, { actor: ctx.actor, jobId });
    job.updatedAt = nowIso();
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.paths.jobs, data);

    await this.log({
      actor: ctx.actor ?? 'ai', action: 'tag-job', entity: 'job', entityId: jobId,
      after: job.businessSkills.join(','),
      note: `AI 打标：${r.resolved.map((x) => x.label).join(' / ')}`
        + (r.created.length ? `（新词：${r.created.join('、')}）` : '')
        + (ctx.reason ? `｜${ctx.reason}` : ''),
    });
    await this.syncMarkdown();
    return {
      job,
      tags: job.aiTags,
      created: r.created,
      reused: r.resolved.filter((x) => !x.isNew).length,
    };
  }

  /** 词表快照（给工作台/Agent 看"现在有哪些词、各被多少条 JD 用到"） */
  async readTaxonomy() {
    const tx = await this.taxonomy();
    const terms = await tx.list();
    return {
      total: terms.length,
      used: terms.filter((t) => t.count > 0).length,
      // hue / group 必须带上：工作台的彩色气泡靠它，缺了就全是一个颜色
      terms: terms.map((t) => ({
        id: t.id, label: t.label, aliases: t.aliases || [], count: t.count || 0,
        hue: typeof t.hue === 'number' ? t.hue : techHue(t.label),
        group: t.group || (TECH_BY_ID.get(t.id) ? TECH_BY_ID.get(t.id).group : null),
        origin: t.origin, lang: t.lang, lastUsedAt: t.lastUsedAt,
        jobIds: t.jobIds || [],
      })),
    };
  }

  /** 手动加词（用户在工作台加技能时同步进词表） */
  async addTaxonomyTerm(label, ctx = {}) {
    const tx = await this.taxonomy();
    const r = await tx.addTerm(label, { origin: ctx.origin || 'user' });
    await this.log({
      actor: ctx.actor ?? 'user', action: 'add-term', entity: 'taxonomy',
      note: `加入词表：${label}${r.isNew ? '' : '（已存在，已复用）'}`,
    });
    return r;
  }

  /** 合并两个同义词（人工兜底，抑制重复词条） */
  async mergeTaxonomyTerms(fromId, intoId, ctx = {}) {
    const tx = await this.taxonomy();
    const r = await tx.merge(fromId, intoId);
    // 合并后要把所有引用旧 id 的 JD 改指到新 id
    const data = await this.readJobs();
    let touched = 0;
    for (const j of data.items) {
      if (!Array.isArray(j.businessSkills)) continue;
      if (!j.businessSkills.includes(fromId)) continue;
      j.businessSkills = [...new Set(j.businessSkills.map((x) => (x === fromId ? intoId : x)))];
      if (Array.isArray(j.aiTags)) {
        j.aiTags = j.aiTags.map((t) => (t.id === fromId ? { ...t, id: intoId } : t));
      }
      touched += 1;
    }
    if (touched) {
      data.updatedAt = nowIso();
      await writeJsonAtomic(this.paths.jobs, data);
      await this.syncMarkdown();
    }
    await this.log({
      actor: ctx.actor ?? 'user', action: 'merge-term', entity: 'taxonomy',
      note: `合并同义词：「${r.merged}」→「${r.into}」，影响 ${touched} 条 JD`,
    });
    return { ...r, touchedJobs: touched };
  }

  /** 重算词表的引用计数（删 JD 或合并之后用） */
  async recomputeTaxonomyCounts() {
    const data = await this.readJobs();
    const tx = await this.taxonomy();
    return tx.recomputeCounts(data.items);
  }

  // ─────────────────────── 简历 ───────────────────────

  async listResumes() {
    await ensureDir(this.paths.resumes);
    const entries = await readdir(this.paths.resumes, { withFileTypes: true });
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    // ⚠️ `.md` 有双重身份：既是允许上传的格式（用户可以直接传 md 简历），
    //    又是解析产物的后缀（r.txt → r.md，产物名去掉了原后缀）。
    //    判据只能是：**去掉 .md 之后，能不能找到一个同名不同后缀的原件**。
    //      r.md 若存在 r.txt / r.docx / r.pdf … → 它是产物，不列为简历。
    const isDerived = (n) => {
      if (n.endsWith('.parsed.txt')) return true;
      if (!/\.md$/i.test(n)) return false;
      const stem = n.replace(/\.md$/i, '');
      return [...names].some((o) => o !== n && o.replace(/\.[^.]+$/, '') === stem);
    };
    const ORIGINALS = /\.(doc|docx|pdf|md|txt|markdown)$/i;
    const out = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (e.name === 'README.md') continue;
      if (isDerived(e.name)) continue;
      if (!ORIGINALS.test(e.name)) continue;
      const full = join(this.paths.resumes, e.name);
      const st = await stat(full);
      // v1.5.4：产物名去原后缀（简历.pdf → 简历.md）
      const mdPath = join(this.paths.resumes, mdNameFor(e.name));
      const parsedPath = join(this.paths.resumes, `${e.name}.parsed.txt`);
      const mdExists = existsSync(mdPath);
      const parsedExists = existsSync(parsedPath);
      out.push({
        name: e.name,
        path: full,
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
        mdPath: mdExists ? mdPath : null,
        parsedPath: parsedExists ? parsedPath : null,
        // legacy 字段：老接口/老前端可能还在读，保留但别信（只看 .parsed.txt）
        hasParsed: parsedExists,
        // ★ 真正的"已解析"判定：正文产物存在任一即可
        readable: mdExists || parsedExists,
        readPath: mdExists ? mdPath : (parsedExists ? parsedPath : null),
      });
    }
    return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  /** 读取简历解析文本（供 Agent 用）。优先 .parsed.txt，回退原文（仅文本型） */
  async readResumeText(name) {
    const safe = basename(name);
    const orig = join(this.paths.resumes, safe);
    if (!existsSync(orig)) throw new Error(`简历不存在：${safe}`);

    // ① 优先读自动生成的 .md（v1.5.3 上传时就转好了；v1.5.4 产物名去后缀）
    const md = join(this.paths.resumes, mdNameFor(safe));
    if (existsSync(md)) {
      return { name: safe, text: await readFile(md, 'utf8'), fromMd: true, path: md };
    }
    // ② 其次读旧的 .parsed.txt（兼容历史数据）
    const parsed = join(this.paths.resumes, `${safe}.parsed.txt`);
    if (existsSync(parsed)) {
      return {
        name: safe, text: await readFile(parsed, 'utf8'), fromParsed: true, path: parsed,
      };
    }
    // ③ 还没有 → 现场解析一次并落盘（老文件是补上的，不是新上传的）
    try {
      const { resumeToMarkdown } = await import('./resume-parse.mjs');
      const r = await resumeToMarkdown(safe, await readFile(orig));
      await writeFile(md, r.md, 'utf8');
      return { name: safe, text: r.md, fromMd: true, path: md, parsedNow: true, source: r.source };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      // ④ 解析不了：如果是纯文本就直接给，否则如实说明
      const buf = await readFile(orig);
      const isBinary = buf.subarray(0, 1024).includes(0);
      if (!isBinary) {
        return { name: safe, text: buf.toString('utf8'), fromParsed: false, path: orig };
      }
      return { name: safe, fromParsed: false, text: null, path: orig, note: msg };
    }
  }

  /** 保存简历解析结果（不改原件） */
  async saveResumeParsed(name, text) {
    const safe = basename(name);
    const orig = join(this.paths.resumes, safe);
    if (!existsSync(orig)) throw new Error(`简历不存在：${safe}（解析结果不能凭空创建）`);
    const out = join(this.paths.resumes, `${safe}.parsed.txt`);
    await writeFile(out, String(text ?? ''), 'utf8');
    await this.log({ actor: 'ai', action: 'parse', entity: 'resume', entityId: safe, note: '生成解析文本，原件未修改' });
    return out;
  }

  /**
   * 保存用户上传的简历（需求 5：界面上传）。
   *
   * 安全约束：
   *   - 只允许白名单扩展名，防止把任意文件写进来
   *   - 文件名做 basename 归一 + 非法字符替换，杜绝路径穿越（../）
   *   - 重名不覆盖：自动加 -1 / -2 后缀，避免用户误传覆盖旧简历
   *   - 大小上限默认 10MB，防止界面被超大文件卡死
   *
   * @param {{name:string, contentBase64?:string, text?:string}} input
   * @returns {Promise<{name:string, path:string, size:number}>}
   */
  async saveResumeUpload(input) {
    const MAX_BYTES = 10 * 1024 * 1024;
    // 白名单按用户要求收紧到 5 种能**解析成文本**的格式。
    // ⚠️ 原来还放过 .rtf/.png/.jpg/.jpeg —— 图片和 rtf 系统读不出文字，
    //    传上来只是占地方（还会让人误以为"上传了系统就看得到"），所以去掉。
    // 允许的格式。图片（.png/.jpg）也在内 —— 它们走 OCR 抽文字，
    // 所以「能上传」和「能读出正文」是配套的（见 resume-parse.mjs 的 ocr 选项）。
    const ALLOWED = ['.doc', '.docx', '.pdf', '.md', '.txt', '.png', '.jpg', '.jpeg'];

    const rawName = String(input?.name || '').trim();
    if (!rawName) throw new Error('缺少文件名');

    // 1) 归一文件名：去掉目录成分 + 替换危险字符
    const safe = basename(rawName).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
    if (!safe || safe === '.' || safe === '..') throw new Error('文件名非法');

    // 2) 扩展名白名单
    const dot = safe.lastIndexOf('.');
    const ext = dot >= 0 ? safe.slice(dot).toLowerCase() : '';
    if (!ALLOWED.includes(ext)) {
      throw new Error(`不支持的文件类型「${ext || '无扩展名'}」。允许：${ALLOWED.join(' / ')}`);
    }

    // 3) 内容：优先 base64，其次纯文本
    let buf;
    if (input.contentBase64) {
      buf = Buffer.from(String(input.contentBase64), 'base64');
    } else if (typeof input.text === 'string') {
      buf = Buffer.from(input.text, 'utf8');
    } else {
      throw new Error('缺少文件内容');
    }
    if (buf.length === 0) throw new Error('文件内容为空');
    if (buf.length > MAX_BYTES) {
      throw new Error(`文件过大（${(buf.length / 1048576).toFixed(1)}MB），上限 ${MAX_BYTES / 1048576}MB`);
    }

    // 4) 重名不覆盖
    await ensureDir(this.paths.resumes);
    let finalName = safe;
    if (existsSync(join(this.paths.resumes, finalName))) {
      const stem = dot >= 0 ? safe.slice(0, dot) : safe;
      let n = 1;
      while (existsSync(join(this.paths.resumes, `${stem}-${n}${ext}`))) n += 1;
      finalName = `${stem}-${n}${ext}`;
    }

    const out = join(this.paths.resumes, finalName);
    await writeFile(out, buf);
    await this.log({
      actor: 'user', action: 'upload', entity: 'resume', entityId: finalName,
      after: { size: buf.length, ext }, note: '用户通过工作台上传',
    });

    // ★ 上传即解析成 .md（Agent 读的是文本，不读二进制）。
    //   解析失败**不删原件、不报错中断上传**，只是没有 md；
    //   失败原因原样带回，界面上告诉用户为什么读不到（如扫描件 PDF）。
    let mdPath = null; let mdError = null; let mdSource = null;
    try {
      const { resumeToMarkdown } = await import('./resume-parse.mjs');
      const r = await resumeToMarkdown(finalName, buf);
      mdPath = join(this.paths.resumes, mdNameFor(finalName));   // v1.5.4 去原后缀
      await writeFile(mdPath, r.md, 'utf8');
      mdSource = r.source;
      await this.log({
        actor: 'system', action: 'parse', entity: 'resume', entityId: finalName,
        note: `已解析为 Markdown（${r.source}，${r.lines} 段），原件未修改`,
      });
    } catch (e) {
      mdError = (e && e.message) || String(e);
      console.warn('[career] 简历解析成 md 失败（原件已保存）：', mdError);
    }

    return { name: finalName, path: out, size: buf.length, mdPath, mdError, mdSource };
  }

  /** 删除简历（原件 + 解析文本）。用户明确要求时才调用。 */
  async deleteResume(name, ctx = {}) {
    const safe = basename(String(name || ''));
    if (!safe) throw new Error('缺少文件名');
    const orig = join(this.paths.resumes, safe);
    if (!existsSync(orig)) throw new Error(`简历不存在：${safe}`);
    const { unlink } = await import('node:fs/promises');
    await unlink(orig);
    const parsed = join(this.paths.resumes, `${safe}.parsed.txt`);
    if (existsSync(parsed)) await unlink(parsed);
    // 自动生成的 .md 是派生物，要一起删（v1.5.4 产物名去原后缀）
    const md = join(this.paths.resumes, mdNameFor(safe));
    if (safe !== 'README.md' && existsSync(md)) await unlink(md);
    // 顺带清掉旧命名遗留的孤儿（v1.5.4 之前是 <原名>.md，如 整合.pdf.md）
    if (safe !== 'README.md' && existsSync(orig)) {
      const legacyMd = `${orig}.md`;
      if (existsSync(legacyMd)) await unlink(legacyMd);
    }
    await this.log({ actor: ctx.actor ?? 'user', action: 'delete', entity: 'resume', entityId: safe });
    return { name: safe };
  }

  // ─────────────────────── Markdown 投影 ───────────────────────

  /**
   * 刷新所有"给人看的产物"：词表计数 → 图谱 → Markdown。
   *
   * ★ v1.5.2：把派生收敛挂在这里，因为**所有写入路径最后都会调它**，
   * 这样新增/修改/删除岗位、打标之后图谱和词表统计立刻是新的，
   * 不用再让用户手点「重算」（那正是"有滞后性"的来源）。
   * ⚠️ 不会递归：`syncDerived` 与 `buildGraph` 都不回调本方法。
   * 收敛失败也不能让本次写入失败，所以只 warn。
   */
  async syncMarkdown() {
    try { await this.syncDerived(); }
    catch (err) { console.warn('[career] 派生数据收敛失败（不影响本次写入）：', err && err.message); }
    return this.syncProjections();
  }

  /** 由 JSON 重新生成人类可读的 .md。JSON 是权威，md 是投影。 */
  async syncProjections() {
    try {
      const profile = await readJson(this.paths.profile, emptyProfile());
      const lines = ['# 职业画像', '', `> 由 profile.json 自动生成于 ${nowIso()}，请勿手改。`, ''];
      if (profile.objective) lines.push(`**职业目标**：${profile.objective}`, '');
      for (const dim of DIMENSIONS) {
        const tags = (profile.tags || []).filter((t) => t.dimension === dim.key);
        if (!tags.length) continue;
        lines.push(`## ${dim.label}`, '');
        for (const t of tags) {
          const flag = t.confirmed ? '' : ' ⚠️待确认';
          const ev = t.evidence ? `（依据：${t.evidence}）` : '';
          lines.push(`- **${t.label}**：${t.value || '—'}${ev}  \`${t.source}\`${flag}`);
        }
        lines.push('');
      }
      await writeFile(this.paths.profileMd, lines.join('\n'), 'utf8');

      const jobs = await readJson(this.paths.jobs, emptyJobs());
      const jl = ['# JD 信息池', '', `> 共 ${(jobs.items || []).length} 条，自动生成于 ${nowIso()}，请勿手改。`, ''];
      const grouped = new Map();
      for (const j of jobs.items || []) {
        if (!grouped.has(j.company)) grouped.set(j.company, []);
        grouped.get(j.company).push(j);
      }
      for (const [company, list] of [...grouped].sort()) {
        jl.push(`## ${company}`, '');
        for (const j of list) {
          jl.push(`### ${j.title}`, '');
          jl.push(`- 城市：${j.city || '—'}  |  状态：${j.status || 'unknown'}  |  来源：${j.source || '—'}`);
          jl.push(`- 记录于：${j.collectedAt}  |  最后更新：${j.updatedAt}`);
          if (j.url) jl.push(`- 链接：${j.url}`);
          if (j.skills?.length) jl.push(`- 关键词：${j.skills.join('、')}`);
          jl.push('');
          if (j.description) jl.push('**岗位描述**', '', j.description, '');
          if (j.requirements) jl.push('**招聘要求**', '', j.requirements, '');
        }
      }
      await writeFile(this.paths.jobsMd, jl.join('\n'), 'utf8');
    } catch (err) {
      // 投影失败不应影响主写入流程
      console.error('[career-store] syncMarkdown 失败：', err && err.message);
    }
  }

  /** 汇总概览，供工作台首页/Agent 快速了解现状 */
  async summary() {
    const [profile, jobs, apps, skills] = await Promise.all([
      this.readProfile(), this.readJobs(), this.readApplications(), this.readSkills(),
    ]);
    const confirmed = profile.tags.filter((t) => t.confirmed).length;
    const pendingConfirmation = profile.tags.filter((t) => !t.confirmed).length;
    const byStatus = {};
    for (const a of apps.items) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    const due = skills.items.filter((s) => s.status !== 'done' && s.targetDate && s.targetDate <= today());
    return {
      profile: { total: profile.tags.length, confirmed, pendingConfirmation, objective: profile.objective || '' },
      jobs: { total: jobs.items.length },
      applications: { total: apps.items.length, byStatus },
      skills: {
        total: skills.items.length,
        byStatus: skills.items.reduce((m, s) => { m[s.status] = (m[s.status] || 0) + 1; return m; }, {}),
        due: due.map((s) => ({ id: s.id, name: s.name, targetDate: s.targetDate })),
      },
      resumes: (await this.listResumes()).length,
    };
  }
}

// ───────────────────────────── 辅助函数 ─────────────────────────────

function emptyProfile() { return { version: 1, objective: '', tags: [], updatedAt: null }; }
function emptyJobs() { return { version: 1, items: [], updatedAt: null }; }
function emptyApplications() { return { version: 1, items: [], updatedAt: null }; }
function emptySkills() { return { version: 1, items: [], updatedAt: null }; }
function emptyGraph() { return { version: 1, generatedAt: null, basedOnJobs: 0, nodes: [], edges: [], topSkills: [] }; }

async function buildGraphFile(file, graph) {
  await ensureDir(dirname(file));
  await writeFile(file, JSON.stringify(graph, null, 2) + '\n', 'utf8');
}

/**
 * JD 去重键。
 *
 * ⚠️ 用 url 做键有个陷阱：**同一个 URL 可能对应多个不同岗位**。
 * 典型是招聘平台的列表型详情页——`?jobUnionId=X` 是「项目」维度，
 * 一个项目下挂多个职位（如美团 LongCat 校招「最多可投 3 个职位」）。
 * 此时两条不同 title 的 JD 会撞成同一个 key，**后写入的静默覆盖前一条**，
 * 用户以为录了 2 条，实际只剩 1 条，且没有任何报错。
 *
 * 因此 url 相同还不足以判定为同一条，必须 **title 也相同** 才算重复；
 * title 不同 → 退化为「公司+岗位+城市」复合键，两条都保留。
 */
function jobKey(j) {
  const url = j.url && String(j.url).trim() ? String(j.url).trim().toLowerCase() : '';
  const ctc = `ctc:${String(j.company || '').trim().toLowerCase()}|${String(j.title || '').trim().toLowerCase()}|${String(j.city || '').trim().toLowerCase()}`;
  if (!url) return ctc;
  // url 单独不足以定性：带上 title，让"同链接不同岗"能共存
  return `url:${url}::title:${String(j.title || '').trim().toLowerCase()}`;
}

function normalizeJob(input) {
  return {
    company: String(input.company || '').trim(),
    title: String(input.title || '').trim(),
    city: input.city ? String(input.city).trim() : '',
    description: input.description ? String(input.description) : '',
    requirements: input.requirements ? String(input.requirements) : '',
    salary: input.salary ? String(input.salary) : '',
    skills: normalizeSkillList(input.skills),
    url: input.url ? String(input.url).trim() : '',
    source: input.source || 'manual',
    status: input.status || 'active',
    raw: input.raw ? String(input.raw) : '',
  };
}

/**
 * 技能列表归一：去空、去重、去首尾空白。
 *
 * ⚠️ **必须保留对象形式**：`skills` 的每一项既可以是字符串，也可以是
 * `{label, aliases?}`（打标时要用 aliases 归并同义词，见 `stampTags`）。
 * 早先这里对每项无条件 `String(raw)`，对象会被压成字面量 `"[object Object]"`
 * —— 标签、图谱、筛选全部拿到一个叫 `[object Object]` 的假技能，且不可逆。
 * 所以：字符串照旧 trim 去重；对象原样透传（只校验 label 非空）。
 */
function normalizeSkillList(list) {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : String(list).split(/[,，、;；|]/);
  const seen = new Map();
  for (const raw of arr) {
    if (raw && typeof raw === 'object') {
      const label = String(raw.label || '').trim();
      if (!label) continue;
      const k = canonicalSkill(label);
      if (!seen.has(k)) {
        seen.set(k, raw.aliases && raw.aliases.length ? { ...raw, label } : label);
      }
      continue;
    }
    const s = String(raw || '').trim();
    if (!s) continue;
    const k = canonicalSkill(s);
    if (!seen.has(k)) seen.set(k, s);
  }
  return [...seen.values()];
}

/** 技能名归一（用于图谱归并去重）：小写、去空格、常见别名折叠 */
const SKILL_ALIASES = new Map([
  ['js', 'javascript'], ['javascript', 'javascript'],
  ['ts', 'typescript'], ['typescript', 'typescript'],
  ['py', 'python'], ['python', 'python'],
  ['golang', 'go'], ['go', 'go'],
  ['c++', 'cpp'], ['cpp', 'cpp'],
  ['c#', 'csharp'], ['csharp', 'csharp'],
  ['k8s', 'kubernetes'], ['kubernetes', 'kubernetes'],
  ['springboot', 'spring boot'], ['spring boot', 'spring boot'],
  ['mysql', 'mysql'], ['mongo', 'mongodb'], ['mongodb', 'mongodb'],
  ['redis', 'redis'], ['docker', 'docker'], ['linux', 'linux'],
  ['机器学习', 'machine learning'], ['ml', 'machine learning'], ['machine learning', 'machine learning'],
  ['nlp', 'nlp'], ['深度学习', 'deep learning'], ['deep learning', 'deep learning'],
  // ── 大模型 / AI 方向补充 ──
  ['pytorch', 'pytorch'], ['torch', 'pytorch'],
  ['tensorflow', 'tensorflow'], ['tf', 'tensorflow'],
  ['transformers', 'transformers'], ['huggingface', 'transformers'],
  ['llm', 'llm'], ['大模型', 'llm'], ['大语言模型', 'llm'],
  ['vllm', 'vllm'], ['sglang', 'sglang'], ['tensorrt', 'tensorrt'],
  ['faiss', 'faiss'], ['milvus', 'milvus'], ['pinecone', 'pinecone'],
  ['langchain', 'langchain'], ['llamaindex', 'llamaindex'],
  ['cuda', 'cuda'], ['triton', 'triton'],
  ['spark', 'spark'], ['flink', 'flink'], ['hadoop', 'hadoop'],
  ['kafka', 'kafka'], ['rabbitmq', 'rabbitmq'],
  ['postgres', 'postgresql'], ['postgresql', 'postgresql'],
  ['elasticsearch', 'elasticsearch'], ['es', 'elasticsearch'],
  ['grpc', 'grpc'], ['microservice', 'microservices'], ['微服务', 'microservices'],
]);

export function canonicalSkill(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return SKILL_ALIASES.get(s) || s;
}

// ═══════════════ 技术标签体系（v1.2 统一版） ═══════════════
/**
 * 设计说明（对应用户反馈 #11）
 *
 * 用户原话：
 *   "技术栈也就是业务能力，不要分开，提取还是太宽泛了，没有适配业务
 *    （比如是后训练？Agent？多Agent协作？多模态视频理解？多模态后训练？
 *    等等这样的技术栈自己想想，不同技术栈用特有的颜色作为气泡颜色，
 *    点击后可以子集跳转到JD池展开所有相关的技术栈的JD）"
 *
 * 因此 v1.2 做了三件事：
 *   1. **合并**：不再区分 `skill`（技术栈词）与 `business_skill`（业务能力），
 *      统一为一个 `tech` 标签体系。图谱里只有一种技能节点。
 *   2. **细分**：从粗放的"大模型/后端"下沉到真正能区分岗位的方向，
 *      例如 `大模型后训练` / `多模态后训练` / `Agent RL` / `多智能体协作` /
 *      `多模态视频理解` / `RAG` / `语音大模型` …
 *   3. **着色**：每个标签带 `color`（HSL 色相），前端渲染成彩色气泡，
 *      点击即筛选出所有相关 JD。
 *
 * 字段说明：
 *   - `id`      稳定标识，图谱归并与筛选都按它。**一旦使用不要改**。
 *   - `label`   中文展示名（前端直接用，避免前端再维护一份映射 → 修掉 v1.1 的 O.8 债）
 *   - `group`   大分组，用于图谱分区展示
 *   - `hue`     色相（0-360）。前端用 `hsl(hue, 62%, 45%)` 生成气泡色。
 *   - `patterns` 命中任意一条即算该标签；中英文都覆盖
 *   - `alias`   可选的展示别名（同一标签的其它常见叫法）
 *
 * ⚠️ **v1.5 起这张表降级为「冷启动种子 + 展示元数据」**，不再是唯一的标签来源：
 *   - **打标**改由大模型完成（`job.aiTags`），词表随之从 0 长大，见 `tech-taxonomy.mjs`；
 *   - 这张表仍负责两件事：
 *       ① 给**历史数据**里的 `businessSkills` id 提供 `label` / `hue` 等展示元数据；
 *       ② 当 Agent 打标时，可以作为"已有词"的一部分让它优先复用（避免同义词分裂）。
 *
 * 扩展方式：往数组里加一项即可，前端会自动拿到 label 与颜色，**无需改前端**。
 * 但新词**首选**让 Agent 打标时自动沉淀进 `tech-taxonomy.mjs` 的词表，不用改代码。
 */
export const TECH_TAGS = [
  // ══════════ 大模型 · 训练侧 ══════════
  {
    id: 'llm-pretrain', label: '大模型预训练', en: 'LLM Pretraining', group: '大模型训练', hue: 265,
    patterns: [/预训练/, /pre[- ]?train/i, /从零训练/, /基础模型训练/, /deepspeed/i,
      /\bmegatron\b/i, /\bfsdp\b/i, /\bzero\b/i, /混合精度/, /梯度累积/, /并行训练/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/pre-?training/i, /pretrained/i, /\bmegatron\b/i, /\bfsdp\b/i, /\bzero\b(-\d)?/i, /mixed precision/i, /foundation model/i, /large language model/i, /\bllm\b/i],
  },
  {
    id: 'llm-post-train', label: '大模型后训练', en: 'LLM Post-training', group: '大模型训练', hue: 275,
    patterns: [/后训练/, /post[- ]?train/i, /\bsft\b/i, /指令微调/, /instruction\s*tun/i,
      /\blora\b/i, /\bqlora\b/i, /\bpeft\b/i, /fine[- ]?tun/i, /微调/, /对齐训练/, /领域适配/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/post-?training/i, /\bsft\b/i, /supervised fine-?tun/i, /instruction tun/i, /\blora\b/i, /\bqlora\b/i, /\bpeft\b/i, /fine-?tun/i, /align(ment)? train/i],
  },
  {
    id: 'alignment-rlhf', label: '对齐与 RLHF', en: 'Alignment & RLHF', group: '大模型训练', hue: 288,
    patterns: [/\brlhf\b/i, /\brlaif\b/i, /人类反馈/, /偏好对齐/, /对齐算法/, /安全对齐/,
      /奖励模型/, /reward\s*model/i, /偏好数据/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/\brlhf\b/i, /\bdpo\b/i, /\bppo\b/i, /\bgrpo\b/i, /human feedback/i, /constitutional ai/i, /preference optimi/i, /safety align/i],
  },
  {
    id: 'reasoning-model', label: '推理模型', en: 'Reasoning Models', group: '大模型训练', hue: 250,
    patterns: [/推理模型/, /reasoning\s*model/i, /长思维链/, /长链推理/, /cot\s*训练/i,
      /\bgrpo\b/i, /思维链训练/, /test[- ]?time\s*compute/i],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/\bcot\b/i, /chain[- ]of[- ]thought/i, /reasoning model/i, /reasoning abilit/i, /test[- ]time compute/i, /\bo1\b/i, /\br1\b/i, /long[- ]chain/i],
  },
  {
    id: 'multimodal-post-train', label: '多模态后训练', en: 'Multimodal Post-training', group: '大模型训练', hue: 320,
    patterns: [/多模态.*后训练/, /多模态.*微调/, /vlm.*train/i, /视觉语言.*训练/,
      /图文.*对齐/, /跨模态对齐/, /多模态对齐/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/multimodal (post|fine)/i, /vision[- ]language (fine|align)/i, /\bvlm\b fine/i, /\bmmllm\b/i],
  },
  {
    id: 'model-distill', label: '模型蒸馏', en: 'Model Distillation', group: '大模型训练', hue: 235,
    patterns: [/蒸馏/, /distill/i, /知识迁移/, /小模型/, /模型压缩/, /剪枝/, /量化训练/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/distillat/i, /teacher[- ]student/i, /knowledge transfer/i, /model pruning/i, /\bpruning\b/i, /模型压缩/i],
  },

  // ══════════ 大模型 · Agent 侧 ══════════
  {
    id: 'agent-engineering', label: 'Agent 工程', en: 'Agent Engineering', group: 'Agent', hue: 200,
    patterns: [/\bagent\b/i, /智能体/, /function\s*call/i, /tool\s*use/i, /\bmcp\b/i,
      /工具调用/, /任务规划/, /planning/, /自主决策/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/\bagent\b/i, /agentic/i, /tool use/i, /tool[- ]calling/i, /function call/i, /workflow orchestrat/i, /langchain/i, /llamaindex/i, /\bmcp\b/i],
  },
  {
    id: 'agent-rl', label: 'Agent RL', en: 'Agent RL', group: 'Agent', hue: 300,
    patterns: [/agent\s*rl/i, /agentic\s*rl/i, /智能体强化学习/, /\bgrpo\b/i,
      /\bppo\b/i, /\bdpo\b/i, /\bgae\b/i, /强化学习/, /rl\s*训练/i, /策略优化/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/agent\s*rl/i, /multi[- ]turn rl/i, /tool[- ]use rl/i, /agent reinforcement/i, /\bgrpo\b/i, /\bapo\b/i],
  },
  {
    id: 'multi-agent', label: '多智能体协作', en: 'Multi-Agent Systems', group: 'Agent', hue: 190,
    patterns: [/多智能体/, /multi[- ]?agent/i, /agent\s*协作/i, /协作智能体/,
      /agent\s*编排/i, /agent\s*通信/, /角色扮演.*agent/i, /swarm/i],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/multi[- ]?agent/i, /agent collaboration/i, /agent swarm/i, /\ba2a\b/i, /agent orchestration/i, /多智能体/i],
  },
  {
    id: 'agent-memory', label: 'Agent 记忆与规划', en: 'Agent Memory & Planning', group: 'Agent', hue: 210,
    patterns: [/agent\s*记忆/, /长期记忆/, /记忆机制/, /上下文管理/, /任务分解/,
      /反思机制/, /reflection/i, /self[- ]?refine/i],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/agent memory/i, /long[- ]term memory/i, /\bmemory\b.*agent/i, /planning.*agent/i, /self[- ]reflect/i, /context management/i],
  },
  {
    id: 'rag', label: 'RAG 检索增强', en: 'RAG', group: 'Agent', hue: 175,
    patterns: [/\brag\b/i, /检索增强/, /retrieval[- ]?augment/i, /知识库问答/,
      /\bgraphrag\b/i, /文档问答/, /知识问答/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/\brag\b/i, /retrieval[- ]augmented/i, /retrieval augmented/i, /knowledge grounding/i, /document qa/i, /\bgraphrag\b/i],
  },
  {
    id: 'vector-search', label: '向量检索', en: 'Vector Search', group: 'Agent', hue: 165,
    patterns: [/向量检索/, /向量数据库/, /embedding/i, /\bfaiss\b/i, /\bmilvus\b/i,
      /\bpinecone\b/i, /\bchroma\b/i, /\bqdrant\b/i, /召回/, /rerank/i, /重排序/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/vector (search|database|store)/i, /\bembedding/i, /\bfaiss\b/i, /\bmilvus\b/i, /\bqdrant\b/i, /\bpinecone\b/i, /approximate nearest neighbor/i, /\bann\b search/i, /similarity search/i],
  },
  {
    id: 'prompt-engineering', label: 'Prompt 工程', en: 'Prompt Engineering', group: 'Agent', hue: 155,
    patterns: [/prompt\s*engineer/i, /提示词/, /提示工程/, /prompt\s*设计/i, /\bcot\b/i,
      /few[- ]?shot/i, /in[- ]?context\s*learn/i],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/prompt engineer/i, /prompt design/i, /prompt tun/i, /few[- ]shot/i, /in[- ]context learning/i, /\bsystem prompt\b/i],
  },
  {
    id: 'agent-eval', label: 'Agent 评测', en: 'Agent Evaluation', group: 'Agent', hue: 145,
    patterns: [/agent\s*评测/, /智能体评测/, /效果评测/, /模型评测/, /benchmark/i,
      /评测集/, /红队/, /自动化评测/, /\beval\b/i],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/agent eval/i, /\bevaluation\b/i, /\bbenchmark/i, /red[- ]team/i, /llm[- ]as[- ]judge/i, /\beval\b set/i, /automatic evaluation/i],
  },

  // ══════════ 大模型 · 推理部署 ══════════
  {
    id: 'llm-inference', label: '推理加速与部署', en: 'LLM Inference & Serving', group: '推理部署', hue: 130,
    patterns: [/推理加速/, /推理优化/, /推理引擎/, /\bvllm\b/i, /\bsglang\b/i,
      /\btensorrt\b/i, /\bkv\s*cache\b/i, /\bflash\s*attention\b/i, /推理服务/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/inference (optimi|acceler|serv)/i, /\bvllm\b/i, /\bsglang\b/i, /\btensorrt\b/i, /\btensorrt[- ]llm\b/i, /kv[- ]?cache/i, /flash[- ]?attention/i, /model serving/i, /\bthroughput\b/i],
  },
  {
    id: 'model-quant', label: '模型量化', en: 'Model Quantization', group: '推理部署', hue: 118,
    patterns: [/量化/, /\bawq\b/i, /\bgptq\b/i, /\bint8\b/i, /\bint4\b/i, /低比特/, /定点化/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/quantizat/i, /\bawq\b/i, /\bgptq\b/i, /\bint8\b/i, /\bint4\b/i, /low[- ]bit/i, /bit width/i],
  },
  {
    id: 'train-infra', label: '训练框架与算力', en: 'Training Frameworks & Compute', group: '推理部署', hue: 108,
    patterns: [/\bcuda\b/i, /\btriton\b/i, /训练框架/, /算力调度/, /\bnccl\b/i,
      /分布式训练/, /gpu\s*集群/i, /显存优化/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/\bcuda\b/i, /\btriton\b/i, /\bnccl\b/i, /distributed training/i, /gpu cluster/i, /memory optimi/i, /\bdeepspeed\b/i, /compute schedul/i],
  },

  // ══════════ 大模型 · 模态 ══════════
  {
    id: 'multimodal-video', label: '多模态视频理解', en: 'Video Understanding', group: '多模态', hue: 350,
    patterns: [/视频理解/, /video\s*understand/i, /视频生成/, /video\s*generat/i,
      /时序建模/, /视频问答/, /video\s*llm/i, /视频检索/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/video understand/i, /video generat/i, /temporal model/i, /video qa/i, /video[- ]language/i, /video retrieval/i, /video llm/i],
  },
  {
    id: 'multimodal-image', label: '多模态图像理解', en: 'Vision-Language Understanding', group: '多模态', hue: 340,
    patterns: [/多模态/, /multimodal/i, /\bvlm\b/i, /视觉语言/, /图文理解/,
      /图像理解/, /视觉问答/, /\bclip\b/i, /图文匹配/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/multimodal/i, /vision[- ]language/i, /image[- ]text/i, /\bvlm\b/i, /image understand/i, /visual question/i, /\bclip\b/i, /image[- ]text matching/i],
  },
  {
    id: 'image-generation', label: '图像生成与编辑', en: 'Image Generation & Editing', group: '多模态', hue: 330,
    patterns: [/图像生成/, /文生图/, /diffusion/i, /扩散模型/, /\bsd\b.*模型/i,
      /图像编辑/, /\bgan\b/i, /aigc\s*图像/i],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/image generat/i, /diffusion model/i, /\btext[- ]to[- ]image\b/i, /stable diffusion/i, /image edit/i, /\bcontrolnet\b/i, /\bflux\b/i, /\bmidjourney\b/i],
  },
  {
    id: 'speech', label: '语音大模型', en: 'Speech & Audio LLM', group: '多模态', hue: 12,
    patterns: [/语音识别/, /\basr\b/i, /语音合成/, /\btts\b/i, /语音大模型/,
      /音频理解/, /声学模型/, /语音交互/, /whisper/i, /interspeech/i, /icassp/i,
      /\btaslp\b/i, /\bjasa\b/i, /说话人/, /语音信号/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/speech recognition/i, /\basr\b/i, /speech synthesis/i, /\btts\b/i, /acoustic model/i, /speech llm/i, /\bwhisper\b/i, /\binterspeech\b/i, /\bicassp\b/i, /\btaslp\b/i, /speaker (recognition|verification)/i],
  },
  {
    // v1.2 补：音频 / 音乐信息检索是独立方向（ISMIR 等），原词表只有「语音大模型」覆盖不到
    // hue 335：与 multimodal-video(350) 错开，避免两个气泡看起来同色
    id: 'audio-music', label: '音频与音乐理解', en: 'Music & Audio Understanding', group: '多模态', hue: 335,
    patterns: [/音乐/, /\bismir\b/i, /音频/, /歌声/, /乐理/, /音频信号/, /听感/, /声纹/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/\bmusic\b/i, /\bismir\b/i, /\baudio\b/i, /music information retrieval/i, /audio signal/i, /\bmel[- ]spectrogram\b/i, /voice conversion/i],
  },
  {
    id: 'cv-classic', label: '计算机视觉', en: 'Computer Vision', group: '多模态', hue: 20,
    patterns: [/计算机视觉/, /目标检测/, /\byolo\b/i, /图像分割/, /\bocr\b/i,
      /人脸识别/, /姿态估计/, /图像分类/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/computer vision/i, /object detection/i, /\byolo\b/i, /image segmentation/i, /\bocr\b/i, /face recognition/i, /pose estimation/i, /image classification/i],
  },
  {
    id: 'embodied-ai', label: '具身智能与机器人', en: 'Embodied AI & Robotics', group: '多模态', hue: 32,
    patterns: [/具身智能/, /机器人/, /\bvla\b/i, /机械臂/, /运动规划/, /仿真环境/, /sim2real/i],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/embodied/i, /\brobotics?\b/i, /\bvla\b/i, /robot manipul/i, /motion planning/i, /\bsim2real\b/i, /autonomous driving/i],
  },

  // ══════════ 算法 ══════════
  {
    // v1.2 补：最基础的「深度学习 / 机器学习」原来没有条目，
    // 导致纯算法岗（关键词只有"深度学习"）抽取结果为空，退化成匹配到描述里的
    // "服务端/移动端/自动化测试" 等边缘词。这里补上基础层。
    id: 'dl-foundation', label: '深度学习基础', en: 'Deep Learning Fundamentals', group: '算法', hue: 205,
    patterns: [/深度学习/, /机器学习/, /神经网络/, /\bdnn\b/i, /表征学习/,
      /深度学习算法/, /模型训练/, /算法模型/, /\bgan\b/i, /生成模型/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/deep learning/i, /machine learning/i, /neural network/i, /\bdnn\b/i, /representation learning/i, /\bgan\b/i, /generative model/i, /model training/i],
  },
  {
    // v1.2 补：自监督 / 对比学习经常是算法岗的核心要求，原先没有对应条目
    id: 'self-supervised', label: '自监督与表征学习', en: 'Self-Supervised & Representation Learning', group: '算法', hue: 218,
    patterns: [/自监督/, /无监督学习/, /对比学习/, /contrastive/i, /自编码/,
      /representation\s*learn/i, /预训练模型/, /掩码建模/, /孪生网络/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/self[- ]supervised/i, /unsupervised learning/i, /contrastive learning/i, /autoencoder/i, /masked (language|image) model/i, /siamese/i, /pretext task/i],
  },
  {
    // v1.2 补：度量学习（人脸/检索/推荐里的核心方向）
    id: 'metric-learning', label: '度量学习', en: 'Metric Learning', group: '算法', hue: 232,
    patterns: [/度量学习/, /metric\s*learn/i, /相似度学习/, /距离度量/, /嵌入学习/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/metric learning/i, /similarity learning/i, /distance metric/i, /embedding learning/i, /\btriplet loss\b/i, /face embedding/i],
  },
  {
    id: 'recsys', label: '推荐系统', en: 'Recommender Systems', group: '算法', hue: 45,
    patterns: [/推荐系统/, /推荐算法/, /\bctr\b/i, /\bcvr\b/i, /排序模型/,
      /召回策略/, /个性化推荐/, /冷启动/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/recommend(er|ation)/i, /\bctr\b/i, /\bcvr\b/i, /ranking model/i, /recall strateg/i, /personaliz/i, /cold start/i, /\buser profile\b/i, /\bdlrm\b/i],
  },
  {
    id: 'search-rank', label: '搜索与排序', en: 'Search & Ranking', group: '算法', hue: 55,
    patterns: [/搜索引擎/, /搜索排序/, /搜索算法/, /query\s*理解/i, /相关性排序/, /意图识别/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/search engine/i, /search ranking/i, /query understand/i, /relevance ranking/i, /intent recogni/i, /\bquery\b.*\brewrite\b/i, /information retrieval/i],
  },
  {
    id: 'advertising', label: '广告算法', en: 'Advertising Algorithms', group: '算法', hue: 65,
    patterns: [/广告算法/, /广告投放/, /\bocpc\b/i, /出价策略/, /流量变现/, /\brtb\b/i],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/advertis/i, /\bad\b ranking/i, /ad targeting/i, /\bbidding\b/i, /campaign optimi/i, /marketing algorithm/i],
  },
  {
    id: 'risk-control', label: '风控与反欺诈', en: 'Risk Control & Fraud Detection', group: '算法', hue: 78,
    patterns: [/风控/, /反欺诈/, /反作弊/, /异常检测/, /风险识别/, /团伙识别/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/risk control/i, /fraud detect/i, /anti[- ]fraud/i, /anomaly detect/i, /risk model/i, /credit scoring/i],
  },
  {
    id: 'knowledge-graph', label: '知识图谱', en: 'Knowledge Graphs', group: '算法', hue: 90,
    patterns: [/知识图谱/, /knowledge\s*graph/i, /\bneo4j\b/i, /实体抽取/, /关系抽取/, /图谱构建/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    // ⚠️ 刻意不用 /\bkg\b/ —— 普通英文里 kg = 公斤，物流/硬件岗位会误命中（体检工具抓到的）
    enPatterns: [/knowledge graph/i, /knowledge\s*graph/i, /graph database/i, /entity linking/i, /entity recognition/i, /relation extraction/i, /\bontology\b/i, /graph neural network/i, /\bgnn\b/i, /triple extraction/i, /graph\s*rag\b|graphrag/i],
  },
  {
    id: 'data-mining', label: '数据挖掘', en: 'Data Mining', group: '算法', hue: 100,
    patterns: [/数据挖掘/, /特征工程/, /用户画像/, /因果推断/, /归因分析/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/data mining/i, /feature engineering/i, /user profiling/i, /causal inference/i, /attribution/i, /statistical analysis/i],
  },

  // ══════════ 工程 ══════════
  {
    id: 'backend-dev', label: '服务端开发', en: 'Backend Development', group: '工程', hue: 220,
    patterns: [/服务端/, /后端/, /后台开发/, /\bapi\b/i, /\brestful\b/i, /\bgrpc\b/i, /接口开发/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/back[- ]?end/i, /server[- ]side/i, /\bapi\b/i, /restful/i, /\brest api\b/i, /\bgrpc\b/i, /spring boot/i, /\bnode\.?js\b/i, /\bdjango\b/i, /\bflask\b/i],
  },
  {
    id: 'distributed', label: '分布式系统', en: 'Distributed Systems', group: '工程', hue: 230,
    patterns: [/分布式/, /一致性协议/, /\braft\b/i, /\bpaxos\b/i, /分布式事务/, /分库分表/, /高可用/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/distributed system/i, /distributed comput/i, /\bconsensus\b/i, /\braft\b/i, /\bpaxos\b/i, /\bsharding\b/i, /\bcap theorem\b/i, /cluster management/i],
  },
  {
    id: 'high-concurrency', label: '高并发架构', en: 'High-Concurrency Architecture', group: '工程', hue: 240,
    patterns: [/高并发/, /高吞吐/, /性能调优/, /性能优化/, /\bqps\b/i, /秒杀/, /削峰填谷/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/high[- ]concurrency/i, /high[- ]throughput/i, /load balanc/i, /performance tun/i, /low latency/i, /\bqps\b/i, /scalab/i],
  },
  {
    id: 'microservices', label: '微服务架构', en: 'Microservices', group: '工程', hue: 248,
    patterns: [/微服务/, /microservice/i, /\bsoa\b/i, /服务治理/, /\bdubbo\b/i, /spring\s*cloud/i, /服务网格/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/micro[- ]?service/i, /service mesh/i, /\bistio\b/i, /api gateway/i, /service governance/i, /\bspring cloud\b/i],
  },
  {
    id: 'middleware', label: '中间件与消息队列', en: 'Middleware & Message Queues', group: '工程', hue: 256,
    patterns: [/中间件/, /消息队列/, /\bmq\b/i, /\bkafka\b/i, /\brocketmq\b/i, /缓存架构/, /消息总线/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/middleware/i, /message queue/i, /\bkafka\b/i, /\brabbitmq\b/i, /\brocketmq\b/i, /\bpulsar\b/i, /\brabbit\b/i, /message broker/i],
  },
  {
    id: 'cloud-native', label: '云原生与容器', en: 'Cloud Native & Containers', group: '工程', hue: 264,
    patterns: [/云原生/, /\bkubernetes\b/i, /\bk8s\b/i, /\bdocker\b/i, /容器化/, /服务编排/, /serverless/i],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/cloud[- ]native/i, /\bkubernetes\b/i, /\bk8s\b/i, /\bdocker\b/i, /container/i, /serverless/i, /\bhelm\b/i, /\bistio\b/i, /\bdevops\b/i],
  },
  {
    id: 'database', label: '数据库与存储', en: 'Databases & Storage', group: '工程', hue: 272,
    patterns: [/数据库/, /\bmysql\b/i, /\bpostgres/i, /\bmongodb\b/i, /\bolap\b/i, /\boltp\b/i,
      /\bclickhouse\b/i, /\bhbase\b/i, /存储引擎/, /索引优化/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/\bmysql\b/i, /\bpostgres(ql)?\b/i, /\bredis\b/i, /\bmongodb\b/i, /\bsql\b/i, /database/i, /storage engine/i, /\bclickhouse\b/i, /index optimi/i],
  },
  {
    id: 'frontend-web', label: 'Web 前端', en: 'Web Frontend', group: '工程', hue: 280,
    patterns: [/前端/, /\breact\b/i, /\bvue\b/i, /\bangular\b/i, /\bwebpack\b/i, /浏览器兼容/, /\bh5\b/i],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/front[- ]?end/i, /\breact\b/i, /\bvue\b/i, /\btypescript\b/i, /\bjavascript\b/i, /\bwebpack\b/i, /\bcss\b/i, /\bhtml\b/i, /browser/i, /\bnext\.js\b/i],
  },
  {
    id: 'mobile', label: '移动端开发', en: 'Mobile Development', group: '工程', hue: 290,
    patterns: [/移动端/, /\bandroid\b/i, /\bios\b/i, /\bflutter\b/i, /react\s*native/i, /小程序/, /客户端开发/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/\bmobile\b/i, /\bios\b/i, /\bandroid\b/i, /\bflutter\b/i, /\breact native\b/i, /client[- ]side/i, /\bswift\b/i, /\bkotlin\b/i, /\bapp develop/i],
  },
  {
    id: 'dev-efficiency', label: '研发效能与 CI/CD', en: 'Developer Productivity & CI/CD', group: '工程', hue: 298,
    patterns: [/\bci\/cd\b/i, /持续集成/, /持续交付/, /研发效能/, /工程效率/, /流水线/, /devops/i],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/\bci\b|\bcd\b|ci-cd|ci\/cd/i, /\bdevops\b/i, /\bjenkins\b/i, /\bgitlab ci\b/i, /\bgithub actions\b/i, /build system/i, /developer productiv/i, /engineering efficiency/i, /\bbazel\b/i],
  },
  {
    id: 'sre', label: '稳定性与 SRE', en: 'Reliability & SRE', group: '工程', hue: 306,
    patterns: [/\bsre\b/i, /稳定性建设/, /可观测/, /监控告警/, /\bapm\b/i, /故障排查/, /运维开发/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/\bsre\b/i, /site reliability/i, /observability/i, /\bmonitoring\b/i, /\bprometheus\b/i, /\bgrafana\b/i, /incident (response|management)/i, /on[- ]call/i, /\bsla\b/i],
  },
  {
    id: 'security', label: '安全', en: 'Security', group: '工程', hue: 314,
    patterns: [/网络安全/, /渗透测试/, /安全攻防/, /漏洞挖掘/, /\bsoc\b/i, /加密算法/, /数据安全/, /隐私计算/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/security/i, /penetration test/i, /\bpen[- ]?test\b/i, /vulnerability/i, /cryptograph/i, /zero trust/i, /\bcompliance\b/i, /\bcve\b/i, /\bsoc\b/i],
  },
  {
    id: 'test-dev', label: '测试开发', en: 'Test Development', group: '工程', hue: 322,
    patterns: [/测试开发/, /自动化测试/, /\bselenium\b/i, /\bcypress\b/i, /性能测试/, /测试框架/, /\bqa\b/i],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/test develop/i, /automation test/i, /automated test/i, /unit test/i, /integration test/i, /\bselenium\b/i, /\bcypress\b/i, /\bpytest\b/i, /test framework/i, /test automation/i],
  },

  // ══════════ 数据 ══════════
  {
    id: 'data-pipeline', label: '数据管道与 ETL', en: 'Data Pipelines & ETL', group: '数据', hue: 40,
    patterns: [/\betl\b/i, /数据管道/, /数据仓库/, /数仓/, /数据清洗/, /离线任务/, /\bhive\b/i, /\bspark\b/i],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/data pipeline/i, /\betl\b/i, /\belt\b/i, /\bairflow\b/i, /\bspark\b/i, /data warehouse/i, /\bhive\b/i, /\bdbt\b/i, /data ingest/i],
  },
  {
    id: 'realtime-compute', label: '实时计算', en: 'Real-Time Computing', group: '数据', hue: 28,
    patterns: [/实时计算/, /流式计算/, /\bflink\b/i, /流处理/, /streaming/i, /实时数仓/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/real[- ]time/i, /\bstream(ing)?\b/i, /\bflink\b/i, /kafka stream/i, /stream process/i, /\bclickhouse\b/i, /\brisingwave\b/i, /real[- ]time data/i],
  },
  {
    id: 'data-governance', label: '数据治理', en: 'Data Governance', group: '数据', hue: 16,
    patterns: [/数据治理/, /元数据/, /数据质量/, /数据血缘/, /主数据/, /数据资产/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/data governance/i, /data quality/i, /\bmetadata\b/i, /data lineage/i, /data catalog/i, /\bdata security\b/i, /master data/i],
  },

  // ══════════ 业务 / 软技能 ══════════
  {
    id: 'product-design', label: '产品设计', en: 'Product Design', group: '业务', hue: 8,
    patterns: [/产品设计/, /需求分析/, /\bprd\b/i, /产品规划/, /用户体验/, /\bux\b/i, /交互设计/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/product design/i, /product manager/i, /\bpm\b.*product/i, /user research/i, /interaction design/i, /\bux\b/i, /\bui\b design/i, /requirement analysis/i],
  },
  {
    id: 'project-mgmt', label: '项目管理', en: 'Project Management', group: '业务', hue: 4,
    patterns: [/项目管理/, /跨团队协作/, /敏捷开发/, /\bscrum\b/i, /进度管理/, /资源协调/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/project manage/i, /\bagile\b/i, /\bscrum\b/i, /\bkanban\b/i, /roadmap/i, /stakeholder/i, /cross[- ]functional/i, /\bjira\b/i],
  },
  {
    id: 'biz-growth', label: '业务增长', en: 'Business Growth', group: '业务', hue: 0,
    patterns: [/业务增长/, /增长黑客/, /用户增长/, /商业变现/, /商业化/, /运营策略/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/business growth/i, /growth hack/i, /user growth/i, /monetiz/i, /commercializ/i, /operation strateg/i, /\bretention\b/i, /\bfunnel\b/i],
  },
  {
    id: 'domain-knowledge', label: '行业领域知识', en: 'Domain Knowledge', group: '业务', hue: 356,
    patterns: [/行业经验/, /领域知识/, /业务理解/, /金融.*经验/, /医疗.*经验/, /电商.*经验/, /教育.*经验/],
    // 英文关键词（需求 2：英文 JD 用英文标签，且中英词表都参与匹配）
    enPatterns: [/domain knowledge/i, /industry experience/i, /financial (industry|experience)/i, /healthcare/i, /e-?commerce/i, /education industry/i, /verticals?/i],
  },
];

/** 每个 JD 最多总结几个技术标签（用户要求：最多 5 个，是**上限**不是目标） */
export const MAX_TECH_PER_JOB = 5;

/**
 * 每个 JD **至少**要有 1 个技术标签。
 *
 * 与「最多 5 个」并不矛盾——用户的两条要求合起来是：
 *   **下限 1、上限 5、中间按相关度**。
 * 于是抽取策略是「门槛优先 + 保底兜底」：
 *   1. 先取所有分数 ≥ `TECH_MIN_SCORE` 的（高置信，可信）；
 *   2. 如果**一个都没有**，退而取**分数最高的那 1 个**，并打上 `lowConfidence: true`；
 *   3. 只有当**完全没有任何词命中**时才返回空数组（这种情况界面要显示"未能识别"，
 *      而不是假装识别到了）。
 *
 * 为什么要区分「高置信」和「兜底」：用户反对的是**把不相关的东西凑进来**，
 * 不是反对"给出一个可能不那么准的方向"。所以兜底的 1 个必须**标注出来**，
 * 让用户和 Agent 知道"这条是推断的，别当硬依据"。
 */
export const MIN_TECH_PER_JOB = 1;

/**
 * 需求 3：**不强行凑满** 5 个。只有分数 ≥ `TECH_MIN_SCORE` 的标签才算**高置信**。
 *
 * 分数含义（见 `extractTechTags` 的权重）：
 *   4 = 出现在**岗位标题**（最核心的信号）
 *   3 = 出现在**技能字段**
 *   2 = 出现在**招聘要求**，或同一标签在描述里命中 2 次
 *   1 = 只在**岗位描述**里命中 1 次（最弱的擦边信号）
 *
 * 门槛取 2 的理由：**能到 2 分就说明它在"要求"层面被明确提过**，
 * 或者至少在描述里出现了两次 —— 这已经不是"顺手一提"。
 * 只有 1 分的（描述里孤零零出现一次）会被丢掉，
 * 而这正是用户抱怨的"把不相关不重要的技能点凝练进来"。
 *
 * ⚠️ 早期版本还叠了一个"相对最高分 35%"的比例门槛，实测**过于激进**：
 * 标题命中权重高（4）会把最高分抬起来，于是一份明确写着
 * 「熟悉 RAG、Agent RL，有 LLM 后训练经验」的 JD 只剩 1 个标签。
 * 比例门槛已移除，只用这个绝对门槛。
 */
export const TECH_MIN_SCORE = 2;

/** id → 标签定义 */
const TECH_BY_ID = new Map(TECH_TAGS.map((t) => [t.id, t]));

/**
 * 按 id 取展示名（前端也会拿到，但服务端也需要用于图谱投影）
 * 支持词表 id（`TECH_TAGS`）与大模型打标出来的任意标签名。
 */
export function techLabel(id) {
  const t = TECH_BY_ID.get(id);
  return t ? t.label : id;
}

/**
 * 关键词兜底建议（v1.5 起**不再用于自动打标**，只作为 Agent 打标的"提示词"）
 *
 * 历史：v1.2~v1.4 用这个函数从 JD 文本里正则匹配出技术标签。
 * v1.5 起打标交给大模型（更准、能泛化到非技术岗），
 * 但这份词表 + 正则仍然保留两个用途：
 *   ① 给历史数据（只有 `businessSkills` id、没有 `aiTags` 的 JD）提供展示元数据；
 *   ② 当 Agent 还没打标时，作为**建议**回给 Agent 参考（不直接落库）。
 *
 * 打分：标题 4 / 技能 3 / 要求 2 / 描述 1，累加；
 * 只保留 ≥ TECH_MIN_SCORE 的，一个都没有时兜底取最高分 1 个并标 lowConfidence。
 */
export function suggestTechTags(job, limit = MAX_TECH_PER_JOB) {
  const fields = [
    { text: String(job.title || ''), weight: 4 },
    { text: (job.skills || []).join(' '), weight: 3 },
    { text: String(job.requirements || ''), weight: 2 },
    { text: String(job.description || ''), weight: 1 },
  ];
  const lang = detectLang([
    job.title, (job.skills || []).join(' '), job.requirements, job.description,
  ].filter(Boolean).join('\n'));

  const scored = [];
  for (const tag of TECH_TAGS) {
    let score = 0;
    // 中英词表**都匹配**：中文 JD 里也会写 Kubernetes / RAG / vLLM。
    // 语言只决定**展示用哪个名字**，不决定能不能匹配上。
    const pats = [...(tag.patterns || []), ...(tag.enPatterns || [])];
    for (const f of fields) {
      if (!f.text) continue;
      for (const p of pats) {
        // 用 match 而非 test：test 带 g 标志会有 lastIndex 副作用
        if (String(f.text).match(p)) score += f.weight;
      }
    }
    if (score > 0) {
      scored.push({
        id: tag.id,
        label: lang === 'en' ? (tag.en || tag.label) : tag.label,
        labelEn: tag.en || tag.label,
        labelZh: tag.label,
        group: tag.group,
        hue: tag.hue,
        score,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (!scored.length) return [];

  let kept = scored.filter((s) => s.score >= TECH_MIN_SCORE);
  if (!kept.length) kept = [{ ...scored[0], lowConfidence: true }];
  return kept.slice(0, Math.max(0, limit)).map((s) => ({ ...s, lang }));
}

/**
 * 按 id 取色相。
 *
 * v1.5：词表开放后，未知 id 不能再统一返回一个固定色（那样所有大模型新词会糊成一片），
 * 改为**按标签名哈希出稳定色相** —— 同一个词永远同色，不同词尽量不同色。
 */
export function techHue(id) {
  const t = TECH_BY_ID.get(id);
  if (t) return t.hue;
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
  return s ? h : 220;
}

/** 按分组聚合标签定义（前端图例用） */
export function techGroups() {
  const m = new Map();
  for (const t of TECH_TAGS) {
    if (!m.has(t.group)) m.set(t.group, []);
    m.get(t.group).push({ id: t.id, label: t.label, hue: t.hue });
  }
  return [...m].map(([group, tags]) => ({ group, tags }));
}

/**
 * 判定一段文本的**主要语言**。
 *
 * 用途（需求 2）：中文 JD 就该显示中文技能标签，英文 JD 显示英文标签。
 * 判据：CJK 字符占比 ≥ 15% 即视为中文。阈值取 15% 而不是 50%，
 * 因为技术 JD 天然混杂大量英文（`Python`、`PyTorch`、`Kubernetes`），
 * 一段"熟悉 Python/PyTorch，有分布式训练经验"显然是中文 JD。
 *
 * @param {string} text
 * @returns {'zh'|'en'}
 */
export function detectLang(text) {
  const s = String(text || '');
  if (!s) return 'zh';                       // 无内容时按主要用户群体默认中文
  const cjk = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const letters = (s.match(/[A-Za-z\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  if (!letters) return 'zh';
  return cjk / letters >= 0.15 ? 'zh' : 'en';
}

/**
 * 按 id 取展示名，可指定语言。
 * @param {string} id
 * @param {'zh'|'en'} [lang] 省略时返回中文名（向后兼容）
 */
export function techLabelIn(id, lang) {
  const t = TECH_BY_ID.get(id);
  if (!t) return id;
  if (lang === 'en') return t.en || t.label;
  return t.label;
}

/**
 * 从一条 JD 中抽取技术标签。
 *
 * ⚠️ **v1.5 起这个方法不再做关键词匹配**，改为「大模型打标优先 + 历史字段兜底」。
 *
 * 为什么改（用户要求）：
 *   旧方案用 53 条写死的词表 + 370 个正则做匹配，问题有三个：
 *   1. **不泛化**：只覆盖技术岗，产品/运营/设计/金融岗位一个标签都抽不出；
 *   2. **粒度粗糙**：「服务端」「移动端」这种在描述里顺带提一次的词会被算进来；
 *   3. **词表改不动**：加一个方向要改代码、加正则、跑测试。
 *
 * 新方案：标签由**大模型读 JD 后自己给**（`job.aiTags`，由 Agent 通过
 * `career_write` 的 `tag_job` 动作写入）。好处：
 *   - 任何行业都能标（模型懂语义，不依赖预置词表）；
 *   - 粒度由模型判断，不会把顺带一提的词当核心方向；
 *   - 词表**从 0 开始随 JD 长大**，且优先复用已有词（见 `tech-taxonomy.mjs`）。
 *
 * ★ **v1.5.1 语义统一：`skills`（编辑栏的「技能关键词」）就是这条 JD 的技术标签。**
 * 以前 `skills` 和 `businessSkills` 是两个各填各的字段，
 * 用户改了前者、后者不动，界面气泡和图谱跟编辑栏对不上。
 * 现在是一个东西的两种形态：
 *   · `skills`         —— 人看/人改的那份（标签名）
 *   · `aiTags`         —— 带中英名与语言的派生投影
 *   · `businessSkills` —— 词表 id 的派生投影（筛选与图谱按键）
 * 三个都由 `stampTags()` 一起刷新，不可能再漂移。
 *
 * 所以录入 JD **一次写入就到位**：Agent 读完正文把方向写进 `skills` 即可，
 * 不需要再单独调一次打标动作。
 *
 * 解析优先级（**只读现成的，绝不自己猜**）：
 *   1. `aiTags`（已投影过的）；
 *   2. `businessSkills`（历史数据里存好的词表 id）；
 *   3. `skills`（编辑栏填的关键词，直接当标签用）；
 *   4. 全都没有 → 空数组，界面显示「待 AI 分析」。
 *
 * @param {object} job JD 记录
 * @param {number} [limit] 上限。**默认 0 = 不截断**：
 *   「1~5 个」是给 AI 打标时的**指令**（在 `stampTags` 里按 capAt 执行），
 *   不是展示层的硬闸门 —— 用户手打了 6 个关键词，
 *   展示时悄悄藏掉第 6 个只会让人以为系统出错。
 * @returns {Array<{id:string,label:string,lang:'zh'|'en',lowConfidence?:true}>}
 */
export function extractTechTags(job, limit = 0) {
  const lang = detectLang([
    job.title, (job.skills || []).join(' '), job.requirements, job.description,
  ].filter(Boolean).join('\n'));
  // limit<=0 表示不截断（默认）。写成 slice(0, 0) 会返回空数组 —— 那就是"标签全没了"。
  const cap = (arr) => (limit > 0 ? arr.slice(0, limit) : arr.slice());

  // ① 已投影过的标签
  if (Array.isArray(job.aiTags) && job.aiTags.length) {
    return cap(job.aiTags).map((t) => {
      const label = typeof t === 'string' ? t : String((t && t.label) || '');
      return {
        id: (t && t.id) || label,
        label,
        labelZh: (t && t.labelZh) || label,
        labelEn: (t && t.labelEn) || label,
        score: (t && t.score) || 0,
        lang: (t && t.lang) || lang,
        ...(t && t.lowConfidence ? { lowConfidence: true } : {}),
      };
    }).filter((t) => t.label);
  }

  // ② 历史数据里已落盘的词表 id
  if (Array.isArray(job.businessSkills) && job.businessSkills.length) {
    return cap(job.businessSkills).map((id) => ({
      id, label: techLabel(id), labelZh: techLabel(id), labelEn: techLabel(id), score: 0, lang,
    }));
  }

  // ③ 编辑栏的「技能关键词」＝标签（用户在 UI 里手填、或 Agent 只写了 skills 时走这里）。
  //    id 用标签名本身（命中预置表时换成预置 id，保持历史数据与颜色可解析）。
  const fromSkills = normalizeSkillList(job.skills).filter(Boolean);
  if (fromSkills.length) {
    return cap(fromSkills).map((label) => {
      const known = knownTermId(label);
      return {
        id: known || label, label, labelZh: label, labelEn: label, score: 0, lang,
      };
    });
  }

  // ④ 都没有 → 如实返回空，界面提示"待 AI 分析"
  return [];
}

/**
 * 把一个标签名解析成预置表里的 id（大小写/空白/全角不敏感，也认英文名）。
 * 命不中返回 null —— 那是活词表里的新词，id 就用标签名本身。
 */
function knownTermId(label) {
  const norm = String(label || '').trim().toLowerCase()
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ');
  if (!norm) return null;
  if (!KNOWN_TERM_BY_NORM) {
    KNOWN_TERM_BY_NORM = new Map();
    for (const t of TECH_TAGS) {
      for (const k of [t.id, t.label, t.en, ...(t.aliases || [])]) {
        const n = String(k || '').trim().toLowerCase();
        if (n && !KNOWN_TERM_BY_NORM.has(n)) KNOWN_TERM_BY_NORM.set(n, t.id);
      }
    }
  }
  return KNOWN_TERM_BY_NORM.get(norm) || null;
}
let KNOWN_TERM_BY_NORM = null;

// ── 向后兼容别名（v1.1/v1.2 的调用点仍可用） ──
// ⚠️ v1.5 起 `BUSINESS_SKILLS` 的含义变了：它不再参与匹配，
//    只作为**词表的冷启动种子**（给历史 id 提供 label/hue，以及给 Agent 当"已有词"参考）。
//    真正在长大的词表在 `tech-taxonomy.mjs`（数据文件，随打标增长）。
export const BUSINESS_SKILLS = TECH_TAGS;
export const MAX_BUSINESS_PER_JOB = MAX_TECH_PER_JOB;
export const extractBusinessSkills = extractTechTags;
export const businessSkillLabel = techLabel;

/**
 * 把抽取结果写回 JD 记录（`businessSkills` + `tagLang` + `tagLowConfidence`）。
 *
 * 统一走这个函数，免得三个写入点（新增 / 更新 / 内容变更）各写一套、漏掉其中一个。
 *
 * @param {object} job 会被就地修改
 * @returns {{ids:string[], lang:'zh'|'en'|undefined, lowConfidence:boolean}} 抽取结果摘要
 */
function applyTags(job) {
  const tags = extractTechTags(job);
  job.businessSkills = tags.map((b) => b.id);
  job.tagLang = tags.length ? tags[0].lang : undefined;
  job.tagLowConfidence = tags.length > 0 && tags.every((t) => t.lowConfidence === true);
  return { ids: job.businessSkills, lang: job.tagLang, lowConfidence: job.tagLowConfidence };
}

export default CareerStore;

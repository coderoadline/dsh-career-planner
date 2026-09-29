/**
 * 技术标签词表（**会长大的数据**，不再是代码里的固定常量）
 *
 * 设计变更（用户要求）：
 *   旧方案：`career-store.mjs` 里写死 53 条 + 370 个正则，靠关键词匹配。
 *   新方案：词表是**工作区里的数据文件**，一开始**从 0 开始**，
 *          由**大模型读 JD 打标**时逐步积累 —— 优先复用已有词，
 *          只有词表描述不了这条 JD 时才加新词。
 *
 * 这样做的三个好处：
 *   1. **泛化**：任何行业（产品/运营/设计/金融）都能长出对应标签，
 *      不再受"53 条只覆盖技术岗"的限制；
 *   2. **抑制同义词**：因为 prompt 要求优先从已有词里挑，
 *      「Agent RL」不会又长出「智能体强化学习」「Agent强化学习」几个变体；
 *   3. **可积累**：用得越多词表越贴合用户真实在看的岗位。
 *
 * 词表来源（两个入口，都落到同一个文件）：
 *   - Agent 打标：打标时发现词表不够 → 加新词（带 `origin:'agent'`）
 *   - 用户手动添加技能：同步进词表（带 `origin:'user'`）
 *
 * 数据文件：`<workspace>/career/taxonomy/tech-terms.json`
 *   {
 *     "version": 1,
 *     "updatedAt": "...",
 *     "terms": [
 *       { id, label, lang, origin, aliases: [], count, firstSeenAt, lastUsedAt, note }
 *     ]
 *   }
 *
 * `count` = 被多少条 JD 引用，用于热度排序与"哪些词其实没用"的清理判断。
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

function nowIso() { return new Date().toISOString(); }

function shortId(prefix) { return `${prefix}-${randomBytes(4).toString('hex')}`; }

async function ensureDir(dir) { await mkdir(dir, { recursive: true }); }

async function readJson(file, fallback) {
  try {
    const txt = await readFile(file, 'utf8');
    if (!txt.trim()) return structuredClone(fallback);
    const parsed = JSON.parse(txt);
    return parsed ?? structuredClone(fallback);
  } catch (err) {
    if (err && err.code === 'ENOENT') return structuredClone(fallback);
    const backup = `${file}.corrupt-${Date.now()}`;
    try { await writeFile(backup, await readFile(file, 'utf8'), 'utf8'); } catch { /* 忽略 */ }
    const e = new Error(`词表文件损坏，已备份到 ${backup}：${err.message}`);
    e.code = 'CORRUPT_JSON';
    throw e;
  }
}

async function writeJsonAtomic(file, value) {
  await ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  try {
    try { await unlink(file); } catch { /* 不存在也正常 */ }
    await rename(tmp, file);
  } catch {
    await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
  }
}

/** 归一化：用于"这个词是不是已经存在"的比较（大小写/空白/全半角不敏感） */
export function normalizeTerm(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    // 全角转半角（英文字母与数字）
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    // 干掉常见装饰性括号后缀：「Agent RL（强化学习）」→「agent rl」
    .replace(/[（(][^）)]*[）)]\s*$/, '')
    .trim();
}

/**
 * 由标签名**稳定地**推导出色相（0-359）。
 *
 * 词表是开放的（大模型随时可能加新词），不能再手工给每个词配 hue，
 * 所以用字符串哈希：同一个词任何时候算出来都是同一个颜色，
 * 不会出现"刷新一下颜色变了"的问题。
 */
export function hueOfLabel(s) {
  let h = 0;
  const str = normalizeTerm(s) || String(s || '');
  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

/**
 * 一个字符串像不像"技术方向词"（可进词表当标签），还是"整句要求"（不该进）。
 *
 * 为什么需要：v1.5.1 把 `skills` 等同于标签后，一条抓取来的 JD 里塞的是
 * 「大模型后训练与对齐（Reward Model / GRPO / PPO / DPO / SFT / R FT）」
 * 「顶会论文或大模型项目主导经验」这类**整句要求**。
 * 直接登记会让词表被噪声占满 —— 而词表一脏，"优先复用"就会把噪声固化下去。
 *
 * 判据刻意保守、只看形状不看语义（宁可漏登记，也别把句子当方向）：
 *   · 含斜杠 / 顿号 / 括号 / 竖线 → 是在罗列或补充说明，不像单一方向词；
 *   · CJK 超过 12 字，或纯拉丁超过 4 个词 → 太长，更像句子；
 *   · 少于 2 字符 → 太短，容易误伤。
 *
 * ⚠️ 只用于 `reconcileTagsAndSkills` 这类**批量登记**场景。
 *    用户或 Agent 显式传的标签**不判** —— 他们说是方向词就是，别替用户做主。
 *
 * @param {string} label
 * @returns {boolean}
 */
export function looksLikeTerm(label) {
  const s = String(label || '').trim();
  if (s.length < 2) return false;
  if (/[/、|()（）]/.test(s)) return false;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjk > 12) return false;
  // 中英混排的长短语（如 "AI Agent 平台与工程知识结合"）光看 CJK 字数会漏判：
  // 它只有 9 个汉字，但整体 20 字符、带空格，明显是一句话而不是方向词。
  if (cjk > 0 && [...s].length > 14) return false;
  const latinWords = (s.match(/[A-Za-z]+/g) || []).length;
  if (!cjk && latinWords > 4) return false;
  return true;
}

/** 词表默认空结构 */
export function emptyTaxonomy() {
  return { version: 1, updatedAt: nowIso(), terms: [] };
}

export class TechTaxonomy {
  /** @param {string} workspaceRoot 工作区根目录（不在 career 下，方便与其他数据并列） */
  constructor(workspaceRoot) {
    this.root = join(workspaceRoot, 'career', 'taxonomy');
    this.file = join(this.root, 'tech-terms.json');
  }

  async init() {
    await ensureDir(this.root);
    try { await readFile(this.file, 'utf8'); }
    catch (err) {
      if (err && err.code === 'ENOENT') await writeJsonAtomic(this.file, emptyTaxonomy());
      else throw err;
    }
    return this;
  }

  async read() {
    const data = await readJson(this.file, emptyTaxonomy());
    if (!Array.isArray(data.terms)) data.terms = [];
    return data;
  }

  /** 词表全部词条（按引用热度降序，其次按最近使用） */
  async list() {
    const data = await this.read();
    return [...data.terms].sort((a, b) => (b.count || 0) - (a.count || 0)
      || String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')));
  }

  /**
   * 精简视图 —— 给 Agent 打标时当"已有词表"用的。
   * 只给必要的三列，控制 prompt 体积；按热度排序，让最该被复用的排前面。
   *
   * @param {number} limit 最多给多少个（默认 200，够覆盖常见规模）
   */
  async listForPrompt(limit = 200) {
    const all = await this.list();
    return all.slice(0, limit).map((t) => ({
      id: t.id, label: t.label, aliases: t.aliases || [], count: t.count || 0, lang: t.lang,
    }));
  }

  /**
   * 解析一组"模型给的标签"→ 落库的词条。
   *
   * **这是抑制同义词的核心**：对每个候选标签，
   *   1. 先按 `id` 精确命中；
   *   2. 再按归一化后的 `label` / `aliases` 命中 → **复用已有词**（不加新词）；
   *   3. 都没有才**新建**词条。
   *
   * 于是模型即使把「Agent RL」写成「智能体强化学习」，
   * 只要后者没登记过就会新建 —— 但因为我们把它写进 `aliases`，
   * **下次再这么写就会被归并到同一条**，不会无限分裂。
   *
   * @param {Array<{id?:string,label:string,aliases?:string[]}>} candidates 模型输出
   * @param {{origin?:'agent'|'user', lang?:'zh'|'en', jobId?:string}} ctx
   * @returns {Promise<{taxonomy:object, resolved:Array<{input:string,id:string,label:string,isNew:boolean}>}>}
   */
  async resolveOrCreate(candidates, ctx = {}) {
    const data = await this.read();
    const byId = new Map(data.terms.map((t) => [t.id, t]));
    /** 归一化 label/alias → 词条，用于"同义词归并" */
    const byNorm = new Map();
    const indexTerm = (t) => {
      for (const k of [t.label, ...(t.aliases || [])]) {
        const n = normalizeTerm(k);
        if (n && !byNorm.has(n)) byNorm.set(n, t);
      }
    };
    for (const t of data.terms) indexTerm(t);

    const resolved = [];
    for (const c of (candidates || [])) {
      const rawLabel = String((c && c.label) || '').trim();
      if (!rawLabel) continue;
      const extraAliases = (Array.isArray(c.aliases) ? c.aliases : [])
        .map((a) => String(a).trim()).filter(Boolean);

      let hit = null;
      // ① id 精确命中
      if (c.id && byId.has(c.id)) hit = byId.get(c.id);
      // ② 归一化 label 命中
      if (!hit) hit = byNorm.get(normalizeTerm(rawLabel)) || null;
      // ③ 任一 alias 命中
      if (!hit) {
        for (const a of extraAliases) {
          const h = byNorm.get(normalizeTerm(a));
          if (h) { hit = h; break; }
        }
      }

      if (hit) {
        // 复用已有词：把新出现的写法沉淀成 alias，下次就认得
        const aliases = new Set([...(hit.aliases || []), ...extraAliases]);
        if (normalizeTerm(rawLabel) !== normalizeTerm(hit.label)) aliases.add(rawLabel);
        aliases.delete(hit.label);
        hit.aliases = [...aliases].filter(Boolean);
        hit.lastUsedAt = nowIso();
        hit.count = (hit.count || 0) + 1;
        if (ctx.jobId) {
          hit.jobIds = Array.isArray(hit.jobIds) ? hit.jobIds : [];
          if (!hit.jobIds.includes(ctx.jobId)) hit.jobIds.push(ctx.jobId);
        }
        resolved.push({ input: rawLabel, id: hit.id, label: hit.label, isNew: false });
      } else {
        // 词表描述不了 → 加新词
        // 调用方给了 id 就沿用它（迁移历史数据 / 用预置词表播种时必须保号），
        // 否则新发一个。大模型正常打标只给 label，所以走新发分支。
        const wantedId = c.id && !byId.has(c.id) ? c.id : shortId('tag');
        // 词表是开放的，颜色默认由标签名哈希**稳定推导**（同词同色，不会刷新就变）；
        // 播种历史数据时可以带进来人工调好的 hue / group。
        const term = {
          id: wantedId,
          label: rawLabel,
          lang: ctx.lang || (/[\u4e00-\u9fff]/.test(rawLabel) ? 'zh' : 'en'),
          origin: ctx.origin || 'agent',
          hue: typeof c.hue === 'number' ? c.hue : hueOfLabel(rawLabel),
          group: c.group || ctx.group || null,
          aliases: extraAliases.filter((a) => normalizeTerm(a) !== normalizeTerm(rawLabel)),
          count: 1,
          firstSeenAt: nowIso(),
          lastUsedAt: nowIso(),
          jobIds: ctx.jobId ? [ctx.jobId] : [],
        };
        data.terms.push(term);
        byId.set(term.id, term);
        indexTerm(term);
        resolved.push({ input: rawLabel, id: term.id, label: term.label, isNew: true });
      }
    }

    data.updatedAt = nowIso();
    await writeJsonAtomic(this.file, data);
    return {
      taxonomy: data,
      resolved,
      created: resolved.filter((r) => r.isNew).map((r) => r.label),
    };
  }

  /** 手动新增一个词（用户在工作台加技能时同步进来） */
  async addTerm(label, ctx = {}) {
    const r = await this.resolveOrCreate([{ label }], { origin: ctx.origin || 'user', lang: ctx.lang });
    return { ...r, id: r.resolved[0] && r.resolved[0].id, isNew: r.created.length > 0 };
  }

  /**
   * 重算每个词的引用计数（被多少条 JD 用到）。
   * 幂等，用于"删了 JD 之后热度要跟着降"和"找出其实没用的词"。
   */
  async recomputeCounts(jobList) {
    const data = await this.read();
    const byId = new Map(data.terms.map((t) => [t.id, t]));
    for (const t of data.terms) { t.count = 0; t.jobIds = []; }
    for (const j of (jobList || [])) {
      for (const id of (j.businessSkills || [])) {
        const t = byId.get(id);
        if (!t) continue;
        t.count = (t.count || 0) + 1;
        t.jobIds.push(j.id);
      }
    }
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.file, data);
    return { terms: data.terms.length, used: data.terms.filter((t) => t.count > 0).length };
  }

  /** 只存在于词表、但没有任何 JD 引用的词（可考虑清理） */
  async unusedTerms() {
    const all = await this.list();
    return all.filter((t) => !t.count);
  }

  async merge(fromId, intoId) {
    const data = await this.read();
    const from = data.terms.find((t) => t.id === fromId);
    const into = data.terms.find((t) => t.id === intoId);
    if (!from || !into) throw new Error('要合并的词条不存在');
    if (fromId === intoId) throw new Error('不能合并到自身');
    into.aliases = [...new Set([...(into.aliases || []), from.label, ...(from.aliases || [])])]
      .filter((a) => normalizeTerm(a) !== normalizeTerm(into.label));
    into.count = (into.count || 0) + (from.count || 0);
    into.jobIds = [...new Set([...(into.jobIds || []), ...(from.jobIds || [])])];
    data.terms = data.terms.filter((t) => t.id !== fromId);
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.file, data);
    return { merged: from.label, into: into.label };
  }

  /** 删除一个词条（连带把它从所有 JD 的引用里清掉由调用方负责） */
  async removeTerm(id) {
    const data = await this.read();
    const t = data.terms.find((x) => x.id === id);
    if (!t) throw new Error('词条不存在');
    data.terms = data.terms.filter((x) => x.id !== id);
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.file, data);
    return { removed: t.label };
  }

  /** 改一个词条的展示名（旧名自动沉淀成 alias，避免以后又分裂） */
  async renameTerm(id, label) {
    const data = await this.read();
    const t = data.terms.find((x) => x.id === id);
    if (!t) throw new Error('词条不存在');
    const next = String(label || '').trim();
    if (!next) throw new Error('新名字不能为空');
    if (normalizeTerm(next) === normalizeTerm(t.label)) return { term: t, changed: false };
    t.aliases = [...new Set([...(t.aliases || []), t.label])]
      .filter((a) => normalizeTerm(a) !== normalizeTerm(next));
    t.label = next;
    t.lang = /[\u4e00-\u9fff]/.test(next) ? 'zh' : 'en';
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.file, data);
    return { term: t, changed: true };
  }

  /**
   * 用**指定 id** 确保一个词条存在（迁移历史数据专用）。
   *
   * 为什么需要：老 JD 的 `businessSkills` 里存的是旧词表的 id（如 `speech`）。
   * 新建词条一律发新 id（`tag-xxxx`）的话，那些历史引用就查不到 label/hue 了。
   * 所以迁移时按**原 id** 落库 —— 老数据零破坏。
   */
  async ensureTermWithId({ id, label, hue, lang, aliases = [], origin = 'seed' }) {
    const data = await this.read();
    const existing = data.terms.find((t) => t.id === id);
    if (existing) return { term: existing, created: false };
    const term = {
      id,
      label,
      lang: lang || (/[\u4e00-\u9fff]/.test(label) ? 'zh' : 'en'),
      origin,
      hue: typeof hue === 'number' ? hue : hueOfLabel(label),
      aliases: aliases.filter(Boolean),
      count: 0,
      firstSeenAt: nowIso(),
      lastUsedAt: null,
      jobIds: [],
    };
    data.terms.push(term);
    data.updatedAt = nowIso();
    await writeJsonAtomic(this.file, data);
    return { term, created: true };
  }

  /**
   * 从历史 JD 里**实际用到的**标签播种词表。
   *
   * ⚠️ 刻意**不是**"把整套 53 条预置词表灌进去" —— 那样词表就不是"从 0 长出来"的了，
   * 而且会把用户从没见过的方向也算成"已有词"，反而干扰模型复用判断。
   * 只播种用户真实数据里出现过的词，并保留其旧 id 与人工调好的 hue。
   *
   * @param {Array<{id:string,businessSkills?:string[]}>} jobList
   * @param {Map<string,{label:string,hue?:number,en?:string}>} legacyById
   */
  async seedFromJobs(jobList, legacyById) {
    const seen = new Set();
    let created = 0;
    for (const j of (jobList || [])) {
      for (const id of (j.businessSkills || [])) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const legacy = legacyById && legacyById.get(id);
        const r = await this.ensureTermWithId({
          id,
          label: (legacy && legacy.label) || id,
          hue: legacy && legacy.hue,
          aliases: legacy && legacy.en ? [legacy.en] : [],
        });
        if (r.created) created += 1;
      }
    }
    return { scanned: seen.size, created };
  }
}

export default TechTaxonomy;

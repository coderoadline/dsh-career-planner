/**
 * career-workbench — Host 半边（文件插件形态）
 *
 * ⚠️ 修正记录：早先的版本用了 `harness.handle(...)`，导致启动崩溃
 *    "ReferenceError: harness is not defined"。
 *    原因：`harness` 是 **动态 Host 半边**（跑在 Cordis 沙箱里的内联代码）才有的
 *    Builtin；本文件是 node_modules 里的**普通文件模块**，全局作用域里没有它。
 *
 * 文件插件的正确做法（参照本 profile 中已工作的 dsh-obsidian-bridge）：
 *     export function apply(ctx)
 *     ctx.inject(['webServer'], (c) => c.effect(() => c.webServer.register({...})))
 *
 * 因此这里改用 webServer 注册一个 HTTP 端点，浏览器端直接 fetch 它。
 *
 * ── 代码与数据的分离（v1.6.0）─────────────────────────────────────────────
 * **代码随插件包走，数据留在用户工作区。**
 *
 *   插件包 <profile>/node_modules/@local/career-workbench/
 *   ├── index.js
 *   ├── client.js
 *   └── store/                    ← 数据层代码（唯一一份，界面与 AI 共用）
 *       ├── career-store.mjs
 *       ├── tech-taxonomy.mjs
 *       └── resume-parse.mjs
 *
 *   用户工作区/
 *   └── career/                   ← 只有数据，首次运行自动建骨架
 *       ├── jobs/ profile/ skills/ ...
 *
 * 数据层**不再复制到工作区**。界面（本文件）与「职业规划」预设的 Agent 工具
 * 都从插件包的 `store/` 加载同一份代码，因此仍共用同一条模块实例 —— 状态机、
 * 去重、审计、以及模块级词表缓存全部只有一份，界面与 AI 天然一致。
 *
 * 本文件负责把包内 `store/` 的绝对路径广播到环境变量 `CAREER_STORE_DIR`，
 * 供预设工具 `career-data-tools.js` 定位（它自己在 .agent-presets/ 分支下，
 * 裸模块名解析不到插件包）。预设工具依赖插件先启动；未启用插件时它会给出
 * 明确报错，而不是静默失败。
 */

import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { syncPresetTrees, resolveDshHome, resolveDataRoot, DATA_DIR_NAME, OWNED_PRESET_IDS } from './preset-sync.mjs';

const ROUTE_PATH = '/dsh-career-planner/api';

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
/** 包内数据层目录（唯一权威代码） */
const BUNDLED_STORE = join(PKG_DIR, 'store');
const STORE_ENTRY = join(BUNDLED_STORE, 'career-store.mjs');
/** 包内预设目录（启动时同步到 <DSH_HOME>/.agent-presets/） */
const BUNDLED_PRESETS = join(PKG_DIR, 'presets');
/** 广播给预设工具的环境变量名 */
const STORE_DIR_ENV = 'CAREER_STORE_DIR';

/**
 * 把包内 `presets/` 同步到 `<DSH_HOME>/.agent-presets/`，让用户装完插件后
 * 无需手动拷贝预设。
 *
 * 同步是幂等的，只覆盖本插件拥有的预设 id（见 `OWNED_PRESET_IDS`），
 * 其它预设目录一律不碰。失败只告警，不阻断插件启动。
 *
 * @param {{logger?: {info?: Function, warn?: Function}}} [ctx] Host context（可选，用于日志）
 */
function syncBundledPresets(ctx) {
  try {
    const targetRoot = join(resolveDshHome(), '.agent-presets');
    const result = syncPresetTrees(BUNDLED_PRESETS, targetRoot, OWNED_PRESET_IDS);
    for (const { id, error } of result.failed) {
      const msg = `[dsh-career-planner] 预设 ${id} 同步失败：${error}`;
      if (ctx && ctx.logger && ctx.logger.warn) ctx.logger.warn(msg); else console.warn(msg);
    }
    if (result.synced.length > 0) {
      const msg = `[dsh-career-planner] 预设已同步到 ${targetRoot}：${result.synced.join('、')}`;
      if (ctx && ctx.logger && ctx.logger.info) ctx.logger.info(msg); else console.log(msg);
    }
  } catch (err) {
    const msg = `[dsh-career-planner] 预设同步异常（不影响插件其它功能）：${(err && err.message) || err}`;
    if (ctx && ctx.logger && ctx.logger.warn) ctx.logger.warn(msg); else console.warn(msg);
  }
}

/**
 * 把包内 `store/` 目录的绝对 `file://` URL 写进 `CAREER_STORE_DIR`。
 *
 * ⚠️ 为什么用环境变量而不是让预设工具直接 import：
 *   预设工具位于 `<DSH_HOME>/.agent-presets/career-planner/tools/`，插件包位于
 *   `<DSH_HOME>/profiles/<profile>/node_modules/@local/`，两者是平行分支 —— 实测
 *   预设文件裸 `import('@local/career-workbench/...')` 报 `ERR_MODULE_NOT_FOUND`。
 *   插件自己站在包的安装位置，能解析到；把结果广播出去，两边就都指向同一份代码。
 *
 * URL 以 `/` 结尾，便于用 `new URL('career-store.mjs', dir)` 拼接。
 * 已由外部显式设置时不覆盖（尊重用户/测试）。
 */
function publishStoreDir() {
  if (process.env[STORE_DIR_ENV] && String(process.env[STORE_DIR_ENV]).trim()) {
    return process.env[STORE_DIR_ENV];
  }
  const dir = pathToFileURL(BUNDLED_STORE).href + '/';
  process.env[STORE_DIR_ENV] = dir;
  return dir;
}

/** 环境变量显式指定（用于测试/特殊部署） */
function explicitWorkspace() {
  const fromEnv = process.env.CAREER_WORKSPACE;
  if (fromEnv && String(fromEnv).trim()) return resolve(String(fromEnv).trim());
  return null;
}

/**
 * 解析数据根目录。
 *
 * 数据放在插件包**之外**的全局目录（`<盘>:/dsh-career-planner-data`，
 * E → D → 其它非 C 盘 → C 优先），理由：
 *   · 放在插件包内 → `dsh plugin add/remove` 会整体替换掉，**用户数据会丢**
 *   · 放在会话工作区 → 工作区随会话变化，用户会以为"数据不见了"
 *
 * 结果同时广播到 `CAREER_DATA_DIR`，供预设工具复用（保证界面与 AI 指向同一目录）。
 */
const DATA_DIR_ENV = 'CAREER_DATA_DIR';

function publishDataDir() {
  const existing = process.env[DATA_DIR_ENV];
  if (existing && String(existing).trim()) return String(existing).trim();
  const dir = resolveDataRoot();
  process.env[DATA_DIR_ENV] = dir;
  return dir;
}

async function workspaceRoot() {
  const explicit = explicitWorkspace();
  if (explicit) return explicit;
  return publishDataDir();
}

async function loadStore() {
  const ws = await workspaceRoot();
  const { existsSync } = await import('node:fs');
  if (!existsSync(STORE_ENTRY)) {
    throw new Error(
      `插件包不完整：找不到数据层 ${STORE_ENTRY}\n`
      + `请确认 dsh-career-planner 安装完整（store/ 目录应含 3 个 .mjs）。`
    );
  }
  // 从**插件包**加载代码（唯一一份），数据目录仍指向工作区
  const mod = await import(pathToFileURL(STORE_ENTRY).href);
  const store = new mod.CareerStore(ws);
  await store.init();
  return { store, mod, ws };
}

function readBody(req) {
  return new Promise((resolvePromise) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 8_000_000) raw = raw.slice(0, 8_000_000); });
    req.on('end', () => {
      try { resolvePromise(raw ? JSON.parse(raw) : {}); }
      catch { resolvePromise({}); }
    });
    req.on('error', () => resolvePromise({}));
  });
}

function sendJson(res, status, value) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify(value ?? null));
  } catch (err) {
    try {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
    } catch { /* 忽略 */ }
  }
}

// ───────────────────────────── 方法路由 ─────────────────────────────

export async function dispatch(method, args) {
  const { store, mod } = await loadStore();
  const a = args || {};

  switch (method) {
    // ---- 读取 ----
    case 'summary':
      return await store.summary();
    case 'getProfile':
      return await store.readProfile();
    case 'getJobs': {
      const data = await store.readJobs();
      return { items: data.items, buckets: await store.jobBuckets() };
    }
    case 'getApplications': {
      const data = await store.readApplications();
      return {
        items: data.items,
        // v1.2 需求 2：带上 rank，前端据此只提供「向前」的状态选项，
        // 从源头上避免用户点到会失败的倒退操作。
        states: Object.fromEntries(
          Object.entries(mod.APPLICATION_STATES).map(([k, v]) => [
            k, { label: v.label, next: v.next, rank: v.rank },
          ])
        ),
      };
    }
    case 'getSkills': {
      const data = await store.readSkills();
      return {
        items: data.items,
        states: Object.fromEntries(Object.entries(mod.SKILL_STATUS).map(([k, v]) => [k, v.label])),
        due: (await store.dueSkills()).map((x) => ({ id: x.id, name: x.name, targetDate: x.targetDate })),
      };
    }
    case 'getGraph':
      return await store.readGraph();
    case 'getResumes':
      return await store.listResumes();
    case 'readResumeText':
      return await store.readResumeText(a.name);
    case 'getEvents':
      return await store.readEvents(a.limit ?? 200);
    case 'getMeta': {
      // v1.5：技术标签词表变成「会随 JD 长大的活词表」。
      // 前端拿到的必须是**实际在用的**那份（含大模型新加的词），
      // 不能再是写死的 53 条 —— 否则新词在界面上只能显示原始 id。
      const tagMeta = await store.tagMeta();
      const liveTags = [...tagMeta.entries()].map(([id, m]) => ({
        id, label: m.label, en: m.labelEn || m.label, group: m.group, hue: m.hue,
        count: m.count || 0, origin: m.origin || 'seed', aliases: m.aliases || [],
      })).sort((x, y) => (y.count || 0) - (x.count || 0)
        || String(x.label).localeCompare(String(y.label)));
      const groups = [...new Set(liveTags.map((t) => t.group).filter(Boolean))];
      return {
        dimensions: mod.DIMENSIONS,
        applicationStates: Object.fromEntries(
          Object.entries(mod.APPLICATION_STATES).map(([k, v]) => [k, { label: v.label, next: v.next, rank: v.rank }])
        ),
        skillStates: Object.fromEntries(Object.entries(mod.SKILL_STATUS).map(([k, v]) => [k, v.label])),
        sources: mod.SOURCES,
        // 活词表（前端直接拿 label / hue / group，不自己维护映射 → O.8 债已修）
        techTags: liveTags,
        techGroups: groups.map((group) => ({
          group, tags: liveTags.filter((t) => t.group === group).map((t) => ({ id: t.id, label: t.label, hue: t.hue })),
        })),
        // 需求 3（上限，不凑数）/ 需求 5（下限，至少 1 个）
        maxTechPerJob: mod.MAX_TECH_PER_JOB,
        minTechPerJob: mod.MIN_TECH_PER_JOB,
        // 抽取门槛（界面可以据此解释"为什么只抽了 2 个"）
        techMinScore: mod.TECH_MIN_SCORE,
        // JD 生命周期参数（界面文案要显示，避免前后端写死两遍）
        jobLifecycle: { staleDays: 15, graceDays: 1 },
        // 可以「复活」的终态（被拒/撤回后重新跟进）
        revivable: [...mod.REVIVABLE],
      };
    }

    // ---- 画像（界面操作 = 用户操作）----
    // ⚠️ 注意 confirmed 的判定：不能无脑传 true。
    // 铁律要求「推断出来的东西，未经用户确认不能变成事实」。
    // 界面手工新增（用户自己敲进去的）→ 天然已确认；
    // 而 ai_inferred / resume_parsed 这类低信任来源，必须保持未确认，
    // 由用户在「待确认」区显式点确认后才升级。
    case 'addProfileTag': {
      const tag = a.tag || {};
      const trusted = tag.source === 'user_explicit' || tag.source === undefined;
      return await store.addProfileTag(tag, { actor: 'user', confirmed: trusted });
    }
    case 'updateProfileTag':
      return await store.updateProfileTag(a.id, a.patch, { actor: 'user', confirmed: a.confirmed });
    case 'deleteProfileTag':
      return await store.deleteProfileTag(a.id, { actor: 'user' });
    case 'confirmTag':
      return await store.updateProfileTag(a.id, {}, { actor: 'user', confirmed: true });
    case 'setObjective':
      return await store.setProfileObjective(a.text, { actor: 'user' });

    // ---- JD 池 ----
    case 'upsertJob':
      return await store.upsertJob(a.job, { actor: 'user' });
    case 'updateJob':
      return await store.updateJob(a.id, a.patch, { actor: 'user' });
    case 'deleteJob':
      return await store.deleteJob(a.id, { actor: 'user' });
    case 'restoreJob':
      return await store.restoreJob(a.id, { actor: 'user' });

    // v1.2 需求 9：JD 生命周期（自动过期 → 检测 → 待删除 → 清理）
    case 'expireStaleJobs':
      return await store.expireStaleJobs(a.days ?? 15, { actor: 'ai' });
    case 'pendingDeleteJobs':
      return await store.pendingDeleteJobs(a.graceDays ?? 1);
    case 'purgePendingDelete':
      return await store.purgePendingDelete(a.graceDays ?? 1, { actor: 'ai' });
    case 'recomputeJobTags':
      return await store.recomputeJobTags({ actor: 'ai' });

    // ---- 技术标签词表（v1.5：由大模型打标，词表随 JD 长大）----
    // 工作台不能自己调模型（Host 半区没有会话上下文），所以这里只提供
    // 「读词表 / 看待打标清单 / 写入模型给的标签 / 合并同义词」四种能力，
    // 打标本身由 career-planner 会话里的 Agent 通过 career_write 完成。
    case 'getTaxonomy':
      return await store.readTaxonomy();
    case 'pendingTagging':
      return await store.pendingTagging(a.limit ?? 100);
    case 'tagJob':
      if (!Array.isArray(a.tags) || !a.tags.length) {
        throw new Error('标签不能为空：每条 JD 至少 1 个');
      }
      return await store.tagJob(a.id, a.tags, { actor: a.actor === 'ai' ? 'ai' : 'user' });
    case 'addTaxonomyTerm':
      return await store.addTaxonomyTerm(a.label, { actor: 'user' });
    case 'mergeTaxonomyTerms':
      return await store.mergeTaxonomyTerms(a.fromId, a.intoId, { actor: 'user' });
    case 'renameTaxonomyTerm':
      return await (await store.taxonomy()).renameTerm(a.id, a.label);

    // ---- 投递 ----
    case 'addApplication':
      return await store.addApplication(a.app, { actor: 'user' });
    case 'setApplicationStatus':
      return await store.setApplicationStatus(a.id, a.status, a.note, {
        actor: 'user', confirmed: true, force: a.force === true,
      });
    // v1.2 需求 3：撤销上一次状态变更
    case 'undoApplicationStatus':
      return await store.undoApplicationStatus(a.id, { actor: 'user' });
    case 'updateApplication':
      return await store.updateApplication(a.id, a.patch, { actor: 'user' });
    case 'deleteApplication':
      return await store.deleteApplication(a.id, { actor: 'user' });

    // ---- 技能 ----
    case 'addSkill':
      return await store.addSkill(a.skill, { actor: 'user', confirmed: true });
    case 'updateSkill':
      return await store.updateSkill(a.id, a.patch, { actor: 'user', confirmed: true });
    case 'deleteSkill':
      return await store.deleteSkill(a.id, { actor: 'user' });
    case 'recordExam':
      return await store.recordExam(a.id, a.exam, { actor: 'user', confirmed: true });

    // ---- 图谱 ----
    case 'rebuildGraph':
      return await store.buildGraph({ actor: 'user' });

    // ---- 简历 ----
    case 'saveResumeParsed':
      return { path: await store.saveResumeParsed(a.name, a.text) };
    // 需求 5：界面上传 / 删除简历
    case 'uploadResume':
      return await store.saveResumeUpload(a);
    case 'deleteResume':
      return await store.deleteResume(a.name, { actor: 'user' });

    // ---- v1.2 需求 9：JD 生命周期 ----
    case 'staleJobs':
      return { items: await store.staleJobs(a.days ?? 15) };
    case 'recordLinkCheck':
      return await store.recordLinkCheck(a.id, a.result || {}, { actor: 'user' });

    /**
     * v1.2 需求 9：批量检测**已过期** JD 的链接是否还能访问。
     *
     * 用户原话："检测失效就是检测所有过期的网站还能不能被访问到，
     *           不能被访问到就标记待删除，一天后删掉。"
     *
     * 所以检测对象是 `status === 'expired'` 的 JD（不是"超期未检测"的）。
     * 由 Host 发起请求（浏览器受 CORS 限制，拿不到真实状态码）。
     *
     * 判定策略偏保守：
     *   - 2xx/3xx        → 存活，复活为 active
     *   - 404 / 410      → 确认下线，标记 pending_delete（待删除）
     *   - 403 / 429 / 5xx / 超时 → 「无法确认」，保持 expired，**不进入待删除**
     *     招聘站点普遍反爬，403 不代表岗位下线，误删代价太高。
     */
    case 'checkLinks': {
      const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 50);
      const all = await store.readJobs();
      // 只检测已过期、且还没被标记待删除的
      const targets = (all.items || [])
        .filter((j) => j.status === 'expired' && j.url)
        .slice(0, limit);
      if (!targets.length) {
        return { checked: 0, revived: 0, pendingDelete: 0, unknown: 0, remaining: 0, results: [] };
      }
      const results = [];
      for (const j of targets) {
        const r = await probeLink(j.url);
        try {
          const saved = await store.recordLinkCheck(j.id, r, { actor: 'ai' });
          results.push({
            id: j.id, url: j.url, company: j.company, title: j.title,
            ...r, status: saved.status,
          });
        } catch (err) {
          results.push({
            id: j.id, url: j.url, company: j.company, title: j.title,
            ...r, error: String((err && err.message) || err),
          });
        }
        await new Promise((r2) => setTimeout(r2, 400));   // 节流
      }
      const stillExpired = (await store.readJobs()).items
        .filter((j) => j.status === 'expired' && j.url).length;
      return {
        checked: results.length,
        revived: results.filter((r) => r.status === 'active').length,
        pendingDelete: results.filter((r) => r.status === 'pending_delete').length,
        unknown: results.filter((r) => r.alive === null).length,
        remaining: stillExpired,
        results,
      };
    }

    /**
     * v1.2：打开工作台时的一次性维护。
     *   1. 超过 15 天没更新的 → 自动标记过期
     *   2. 待删除且超过宽限期的 → 真正删除
     * 界面调用它来做"自动化"，让用户不用手动点。
     */
    case 'runMaintenance': {
      const staleDays = a.staleDays ?? 15;
      const graceDays = a.graceDays ?? 1;
      const expired = await store.expireStaleJobs(staleDays, { actor: 'ai' });
      const purged = await store.purgePendingDelete(graceDays, { actor: 'ai' });
      const pending = await store.pendingDeleteJobs(graceDays);
      return {
        expired: expired.expired,
        purged: purged.purged,
        purgedTitles: purged.titles,
        pendingDelete: pending.length,
      };
    }

    default:
      throw new Error(`未知方法：${method}`);
  }
}

/**
 * 探测一个链接是否还活着（需求 2）。
 *
 * @returns {Promise<{alive:boolean|null, httpStatus:number|null, note:string}>}
 *   alive = true  链接存活
 *   alive = false 明确下线（404 / 410）
 *   alive = null  无法确认（反爬、超时、需要登录…）——**不算过期**
 */
async function probeLink(url) {
  if (!url || typeof url !== 'string') {
    return { alive: null, httpStatus: null, note: '没有链接，跳过' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // 先 HEAD 省流量；很多站点不支持 HEAD，失败再退回 GET
    let res = null;
    try {
      res = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; career-workbench/1.0)' },
      });
    } catch { /* 落到 GET */ }

    if (!res || res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; career-workbench/1.0)' },
      });
    }

    const s = res.status;
    if (s === 404 || s === 410) {
      return { alive: false, httpStatus: s, note: `页面不存在（HTTP ${s}）` };
    }
    if (s >= 200 && s < 400) {
      return { alive: true, httpStatus: s, note: '链接存活' };
    }
    // 403/429/5xx：多为反爬或临时故障，不能据此判定下线
    return { alive: null, httpStatus: s, note: `无法确认（HTTP ${s}，可能是反爬或临时故障）` };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message)));
    return {
      alive: null, httpStatus: null,
      note: aborted ? '请求超时，无法确认' : `请求失败，无法确认（${(err && err.message) || err}）`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────────── 插件入口 ─────────────────────────────

export function apply(ctx) {
  // 把包内 store/ 的位置广播给预设工具（必须在任何 loadStore() 之前）
  publishStoreDir();

  // 把全局数据目录广播给预设工具，保证界面与 AI 指向同一份数据
  publishDataDir();

  // 把包内预设同步到 <DSH_HOME>/.agent-presets/，用户无需手动拷贝。
  // 幂等，且只覆盖本插件拥有的预设 id。失败只告警，不阻断启动。
  syncBundledPresets(ctx);

  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
          });
          res.end();
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '只接受 POST' });
          return;
        }
        let payload;
        try {
          payload = await readBody(req);
        } catch (err) {
          sendJson(res, 400, { ok: false, error: '请求体解析失败：' + ((err && err.message) || err) });
          return;
        }
        const { method, args } = payload || {};
        if (!method || typeof method !== 'string') {
          sendJson(res, 400, { ok: false, error: '缺少 method' });
          return;
        }
        try {
          const value = await dispatch(method, args);
          sendJson(res, 200, { ok: true, value });
        } catch (err) {
          // 业务错误（如状态机校验失败）也走 200，让前端能显示 message
          sendJson(res, 200, { ok: false, error: String((err && err.message) || err) });
        }
      },
    }), 'dsh-career-planner:api-route');
  });

  // 启动自检：确认数据层可加载，避免"装上了但一用就报错"
  ctx.inject(['webServer'], async () => {
    try {
      const { store, ws } = await loadStore();
      await store.init();
      console.log(`[dsh-career-planner] 已挂载 ${ROUTE_PATH}；数据目录 ${join(ws, 'career')}`);
    } catch (err) {
      console.warn('[dsh-career-planner] 数据层不可用：', (err && err.message) || err);
    }
  });
}

export const name = 'dsh-career-planner';
export default apply;

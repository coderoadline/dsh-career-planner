/**
 * career-data-tools — 职业数据读写工具（Agent 侧，预设模块行）
 *
 * 向 Agent 注册两个工具：
 *   - career_read  : 按需读取画像 / JD 池 / 投递 / 技能 / 图谱 / 简历
 *   - career_write : 写入（确认门语义由 confirmed 字段承载）
 *
 * 数据实现复用**插件包**里的 career-store.mjs —— 与「职业规划工作台」插件
 * 是同一个模块实例，界面与 AI 走同一套规则（同状态机、同去重、同审计）。
 *
 * ⚠️ 代码从哪来（v1.6.0）：
 *   数据层代码随插件包分发，本文件**不能**用裸模块名 import 它 —— 本文件位于
 *   `<DSH_HOME>/.agent-presets/career-planner/tools/`，插件包位于
 *   `<DSH_HOME>/profiles/<profile>/node_modules/@local/`，是平行分支，实测
 *   裸 `import('@local/career-workbench/store/...')` 报 ERR_MODULE_NOT_FOUND。
 *
 *   所以由插件（career-workbench/index.js）在启动时把包内 store/ 的绝对
 *   file:// URL 写进环境变量 `CAREER_STORE_DIR`，本文件从它加载。
 *   **依赖插件先启动**；未启用插件时给出明确报错（而不是静默用错数据层）。
 *
 * ⚠️ ToolDefinition 的真实契约（经 cordis_inspect 核对，勿凭记忆改）：
 *     { name, description, parameters, output: { schema, render },
 *       execute(args, exec) }
 *   注意是 `execute` 而不是 `handler`；`output` 是必填的。
 */

/**
 * 声明硬依赖。
 *
 * ⚠️ Cordis 规定：只有写进 inject 的服务才能用 `ctx.<name>` 访问；
 * 否则一律抛 "cannot get property \"tools\" without inject"。
 * 之前直接读 `ctx.tools` 就是这个报错，导致整个预设无法切换。
 *
 * 这里声明 tools 为硬依赖（没有 tools 注册表就没法注册工具，语义正确）。
 */
export const inject = ['tools'];

/**
 * workspaceRegistry 是**可选**依赖：不是每个部署都提供。
 * 因此用 ctx.get('workspaceRegistry') 探测，不写进 inject，
 * 避免在缺失时把整个预设拖垮（缺它时回退到 cwd / 环境变量）。
 */
export function apply(ctx) {
  // 只用 ctx.get 探测（显式 undefined 检查）。
  // 不写 `: ctx.tools` 兜底：在 Cordis 里未声明 inject 时访问 ctx.tools 会直接抛错，
  // 那种"兜底"反而会把插件炸掉。tools 已由上面的 inject 保证可用。
  const tools = ctx.get ? ctx.get('tools') : undefined;
  if (!tools || typeof tools.register !== 'function') {
    console.warn('[career-data-tools] tools 服务不可用，跳过注册');
    return;
  }

  const rootCtx = ctx;
  const disposers = [];
  for (const def of [readTool(rootCtx), writeTool(rootCtx)]) {
    try {
      disposers.push(tools.register(def));
    } catch (err) {
      console.error(`[career-data-tools] 注册工具 ${def.name} 失败：`, (err && err.message) || err);
    }
  }

  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const d of disposers) {
        try { d(); } catch { /* 卸载失败不阻塞 */ }
      }
    }, 'career-data-tools');
  }
}

// ───────────────────────────── 工作区解析 ─────────────────────────────

/**
 * 解析数据根目录（**数据**所在处；代码在插件包里，不在这里）。
 *
 * 与工作台插件（index.js）共用同一个约定，保证界面与 AI 指向同一份数据：
 *   1. `CAREER_WORKSPACE` —— 用户/测试显式指定（最高优先）
 *   2. `CAREER_DATA_DIR`  —— 工作台插件启动时广播的全局数据目录
 *   3. 都没有 → 报错（插件没启用，数据层本来就加载不了）
 */
async function workspaceRoot(ctx) {
  const explicit = process.env.CAREER_WORKSPACE;
  if (explicit && String(explicit).trim()) return String(explicit).trim();

  const fromPlugin = process.env.CAREER_DATA_DIR;
  if (fromPlugin && String(fromPlugin).trim()) return String(fromPlugin).trim();

  throw new Error(
    '找不到职业数据目录：环境变量 CAREER_DATA_DIR 未设置。\n'
    + '它由「职业规划工作台」插件（dsh-career-planner）在启动时写入。'
    + '请确认该插件已在当前 profile 启用并重启 DSH；'
    + '或手动设置 CAREER_WORKSPACE 指向你的数据目录。'
  );
}

/**
 * 从插件包加载数据层代码，并把**工作区数据目录**交给它。
 *
 * 代码位置来自 `CAREER_STORE_DIR`（插件启动时广播的绝对 file:// URL）。
 * 取不到就明确报错 —— 这通常意味着工作台插件没启用。
 */
async function loadStore(ctx) {
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const ws = await workspaceRoot(ctx);

  const storeDir = process.env.CAREER_STORE_DIR;
  if (!storeDir || !String(storeDir).trim()) {
    throw new Error(
      '找不到职业数据层代码：环境变量 CAREER_STORE_DIR 未设置。\n'
      + '它由「职业规划工作台」插件（@local/career-workbench）在启动时写入。'
      + '请确认该插件已在当前 profile 启用并重启 DSH；'
      + '或手动把 CAREER_STORE_DIR 指向插件包内的 store/ 目录（file:// URL，以 / 结尾）。'
    );
  }
  const storeEntry = new URL('career-store.mjs', String(storeDir).trim()).href;
  const storeEntryPath = fileURLToPath(storeEntry);
  if (!existsSync(storeEntryPath)) {
    throw new Error(
      `CAREER_STORE_DIR 指向的目录里没有 career-store.mjs：${storeEntryPath}\n`
      + `当前 CAREER_STORE_DIR = ${storeDir}。请确认插件包安装完整（store/ 应有 3 个 .mjs）。`
    );
  }
  const mod = await import(storeEntry);
  const store = new mod.CareerStore(ws);
  await store.init();
  return { store, mod, ws };
}

/** 统一的 tool output 定义：把 JSON 结果渲染成一段文本 */
function textOutput(render) {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (args, value) => [{ type: 'text', text: render(args, value) }],
  };
}

function safeJson(value, max = 40_000) {
  try {
    const s = JSON.stringify(value, null, 2);
    return s.length > max ? s.slice(0, max) + '\n…（已截断）' : s;
  } catch {
    return String(value);
  }
}

// ───────────────────────────── career_read ─────────────────────────────

function readTool(rootCtx) {
  return {
    name: 'career_read',
    description:
      '读取用户的职业规划数据（职业画像 / JD 信息池 / 投递进度 / 技能清单 / 技能图谱 / 简历 / 标签词表）。\n'
      + 'kind=summary 一次拿到全局概览，是最常用入口。需要最新状态时重新读取，不要依赖记忆。\n'
      + 'kind=taxonomy 读标签词表 —— **给 JD 打标（career_write 的 tag_job）前先读它**，'
      + '优先复用已有词，避免同义词分裂。\n'
      + '未确认的画像标签（confirmed=false）不参与正式结论，返回值中会单独列在 pendingConfirmation。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['summary', 'profile', 'jobs', 'applications', 'skills', 'graph', 'resumes', 'events', 'taxonomy'],
          description: '要读取的数据类别。taxonomy = 标签词表（打标前先看它，优先复用已有词）。',
        },
        confirmedOnly: { type: 'boolean', description: 'profile 时只返回已确认标签。默认 false。' },
        company: { type: 'string', description: 'jobs 时按公司模糊过滤。' },
        city: { type: 'string', description: 'jobs 时按城市模糊过滤。' },
        keyword: { type: 'string', description: 'jobs 时按关键词过滤（标题/描述/要求/技能）。' },
        name: { type: 'string', description: 'resumes 时指定文件名，直接读出该简历的正文（系统已自动转成 .md）。' },
        status: { type: 'string', description: 'applications/skills 时按状态过滤。' },
        limit: { type: 'number', description: '返回条数上限，默认 100。' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    output: textOutput((args, value) => {
      if (value && value.error) return `读取失败：${value.error}`;
      return safeJson(value);
    }),
    async execute(args) {
      const { store, mod } = await loadStore(rootCtx);
      const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 5000);

      switch (args.kind) {
        case 'summary':
          return await store.summary();

        case 'taxonomy': {
          // v1.5：打标前先看这里 —— 优先复用已有词，避免同义词分裂
          const tx = await store.readTaxonomy();
          return {
            total: tx.total,
            used: tx.used,
            hint: '给 JD 打标时（career_write 的 tag_job）**优先从这个表里选词**：'
              + 'label 或 aliases 命中即算复用，大小写/空格/全角不敏感。'
              + '只有当这里确实没有能描述该 JD 的词时，才新增。',
            terms: tx.terms.slice(0, limit).map((t) => ({
              // id 必须给：`merge_terms` 要 fromId/intoId，
              // 只给名字的话模型想合并同义词时无从下手。
              id: t.id,
              label: t.label,
              aliases: t.aliases,
              usedBy: t.count,
              origin: t.origin,
            })),
          };
        }

        case 'profile': {
          const data = await store.readProfile();
          const tags = args.confirmedOnly ? data.tags.filter((t) => t.confirmed) : data.tags;
          return {
            objective: data.objective,
            totalTags: data.tags.length,
            pendingConfirmation: data.tags.filter((t) => !t.confirmed).map((t) => ({
              id: t.id, dimension: t.dimension, label: t.label, value: t.value, source: t.source,
            })),
            tags: tags.slice(0, limit),
          };
        }

        case 'jobs': {
          const data = await store.readJobs();
          let items = data.items;
          if (args.company) {
            const q = String(args.company).toLowerCase();
            items = items.filter((j) => String(j.company || '').toLowerCase().includes(q));
          }
          if (args.city) {
            const q = String(args.city).toLowerCase();
            items = items.filter((j) => String(j.city || '').toLowerCase().includes(q));
          }
          if (args.keyword) {
            const q = String(args.keyword).toLowerCase();
            items = items.filter((j) => ['title', 'description', 'requirements', 'company', 'city']
              .some((f) => String(j[f] || '').toLowerCase().includes(q))
              || (j.skills || []).some((s) => String(s).toLowerCase().includes(q)));
          }
          return {
            total: data.items.length,
            matched: items.length,
            buckets: await store.jobBuckets(),
            items: items.slice(0, limit),
          };
        }

        case 'applications': {
          const data = await store.readApplications();
          let items = data.items;
          if (args.status) items = items.filter((a) => a.status === args.status);
          return {
            total: data.items.length,
            states: Object.fromEntries(Object.entries(mod.APPLICATION_STATES).map(([k, v]) => [k, v.label])),
            items: items.slice(0, limit),
          };
        }

        case 'skills': {
          const data = await store.readSkills();
          let items = data.items;
          if (args.status) items = items.filter((s) => s.status === args.status);
          return {
            total: data.items.length,
            states: Object.fromEntries(Object.entries(mod.SKILL_STATUS).map(([k, v]) => [k, v.label])),
            due: (await store.dueSkills()).map((s) => ({ id: s.id, name: s.name, targetDate: s.targetDate })),
            items: items.slice(0, limit),
          };
        }

        case 'graph': {
          const g = await store.readGraph();
          return {
            generatedAt: g.generatedAt,
            basedOnJobs: g.basedOnJobs,
            topSkills: g.topSkills,
            skillNodes: g.nodes.filter((n) => n.type === 'skill'),
            note: g.generatedAt ? undefined : '图谱尚未生成。可用 career_write 的 rebuild_graph 动作生成。',
          };
        }

        case 'resumes': {
          // 给了 name 就直接把正文（已自动转成 .md）带回来，省得 Agent 再开文件
          if (args.name) {
            const r = await store.readResumeText(args.name);
            return {
              ...r,
              // 明确告诉它路径，以后可以直接读这个文件
              hint: r.text
                ? `简历正文已读出（来自 ${r.fromMd ? '自动生成的 .md' : r.fromParsed ? '.parsed.txt' : '原文'}）。`
                  + '灌画像时 source 必须是 resume_parsed，且 confirmed=false（待用户确认）。'
                : (r.note || '读不出文字'),
            };
          }
          const items = await store.listResumes();
          return {
            items,
            hint: '每条都带 readPath（该读哪个文件）。readable=false 说明抽不出文字，'
              + '这时别硬编内容——直接让用户把简历文字贴给你。',
          };
        }

        case 'events':
          return { items: await store.readEvents(limit) };

        default:
          throw new Error(`未知的 kind：${args.kind}`);
      }
    },
  };
}

// ───────────────────────────── career_write ─────────────────────────────

function writeTool(rootCtx) {
  return {
    name: 'career_write',
    description:
      '写入用户的职业规划数据。所有写入都会记入审计日志（career/logs/events.jsonl）。\n\n'
      + '【确认门 — 必须遵守】\n'
      + '- 用户显式要求修改（"帮我更新 X 的一面过了"、"我想学 Z"）→ 直接写入，confirmed=true。\n'
      + '- 只是顺口提到（"我今天面了 X"、"最近在看 Go"）→ 必须先问用户，得到确认后才写入，并传 confirmed=true。\n'
      + '- 未经确认的推断写入画像时传 confirmed=false（成为待确认标签，不参与正式结论）。\n'
      + '  投递与技能属于用户事实数据，不允许未确认写入（工具会直接拒绝）。\n\n'
      + '动作：upsert_tags / update_tag / delete_tag / set_objective（画像）；'
      + 'upsert_jobs / update_job / delete_job / tag_job（JD 池）；'
      + 'add_application / set_application_status / update_application / delete_application（投递）；'
      + 'add_skill / update_skill / delete_skill / record_exam（技能）；'
      + 'add_term / merge_terms（标签词表）；rebuild_graph（图谱）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'upsert_tags', 'update_tag', 'delete_tag', 'set_objective',
            'upsert_jobs', 'update_job', 'delete_job', 'tag_job',
            'add_application', 'set_application_status', 'update_application', 'delete_application',
            'add_skill', 'update_skill', 'delete_skill', 'record_exam',
            'add_term', 'merge_terms',
            'rebuild_graph',
          ],
          description: '要执行的写入动作。',
        },
        confirmed: {
          type: 'boolean',
          description:
            '本次写入是否已获用户确认。投递/技能类要求 true。\n'
            + '⚠️ 这是**调用级**开关，不是单条字段：upsert_tags 时它只作用于非推断来源的标签。\n'
            + 'source=ai_inferred 的标签**永远不会**被它确认为 true（除非该条自己写了 confirmed:true）——\n'
            + '所以事实标签与推断标签请**拆成两次调用**，不要混批，否则推断会被误标为已确认。',
        },
        tags: {
          type: 'array',
          description:
            '两个动作用这个字段（看 action 区分）：\n'
            + '· upsert_tags：每项 {dimension,label,value,evidence,source,confidence}。source 必填'
            + '（user_explicit/resume_parsed/ai_inferred）。\n'
            + '· tag_job：**只给"已经存在但还没有标签"的 JD 补标用**'
            + '（典型是用户在工作台手动录入、技能关键词留空的那些）。'
            + '正常录入 JD 请直接把标签写进 upsert_jobs 的 `skills`，一次到位，'
            + '**不用**再调这个动作。\n'
            + '  每项 {label, aliases?}，约束与 skills 完全相同：'
            + '先读 taxonomy 优先复用已有词、1~5 个、语言跟界面一致、不限技术岗。',
          items: { type: 'object', additionalProperties: true },
        },
        id: { type: 'string', description: 'update_*/delete_*/set_application_status/record_exam 的目标 id。' },
        patch: { type: 'object', description: 'update_* 的字段补丁。', additionalProperties: true },
        objective: { type: 'string', description: 'set_objective：职业目标文本。' },
        jobs: {
          type: 'array',
          description:
            'upsert_jobs：每项 {company,title,city,description,requirements,salary,'
            + '**skills**,url,source,status}。必须带 url 与 source。\n\n'
            + '⚠️ **`description` / `requirements` / `title` 只放 JD 原文，一个字都不加。**\n'
            + '不得添加自己的判断、推断、评价或后缀。尤其禁止在正文里写'
            + '「（不卡届别，2028 届可投）」这类**结论**——原文没写届别就当没写，'
            + '门槛判断放到你的回复里说，不要塞进 JD 记录。\n'
            + '已知翻车：一条 JD 原文写「2026 届获得本科及以上」，却被加了'
            + '「不卡届别，2028 届可投」，导致用户被推荐去投一条他够不着的岗位。\n'
            + '`source` 只写来源站点（如「美团招聘官网」），不写核实过程、不写 ID、不加括号注解。\n\n'
            + '★ `skills` **就是这条 JD 的技术标签**（界面上显示成彩色气泡、'
            + '图谱按它统计、点一下筛选出同类 JD 的那份）。'
            + '所以**录入时就要把标签一起写进来**，不要再单独调一次打标动作 —— '
            + '你已经读过这份 JD 了，再跑一次纯属浪费。\n'
            + '【skills 的约束】\n'
            + '1. **先读词表**：career_read 的 kind=taxonomy，'
            + '**优先复用已有词**（label 或任一 aliases 命中即算复用，'
            + '大小写/空格/全角不敏感）。只有词表确实描述不了这份 JD 时才加新词 —— '
            + '这条是抑制同义词分裂的关键（别再造出一个「检索增强生成」和 RAG 并列）。\n'
            + '2. **1~5 个**，按重要程度排序。只标真正构成该岗位方向的东西：'
            + '行文顺带提一句"需与算法同学沟通"不等于算法岗。宁缺勿滥，但至少有 1 个。\n'
            + '3. **词的语言跟系统界面语言一致**（中文界面 → 中文词）；'
            + '英文专有名词（`RAG`、`Kubernetes`、`vLLM`）保持原样。\n'
            + '4. **不限技术岗**：产品/运营/设计/金融/供应链同样要标，'
            + '按该行业自己的方向词来（如「用户增长」「风控与反欺诈」「B 端产品」）。\n'
            + '5. 换了叫法时给 `aliases`：想写「智能体强化学习」而词表里是 '
            + '「Agent RL」，就写成 {label:"智能体强化学习", aliases:["Agent RL"]}，'
            + '系统会归并到同一条并把你的说法记成别名，下次不会再分裂。',
          items: { type: 'object', additionalProperties: true },
        },
        status: {
          type: 'string',
          description: 'set_application_status 的目标状态（wishlist/applied/resume_screen/written_test/interview_1/interview_2/interview_3/hr_interview/offer/accepted/rejected/withdrawn）；update_skill 时为技能状态（todo/learning/examining/done）。',
        },
        note: { type: 'string', description: '投递状态变更备注（写进 timeline）。' },
        force: { type: 'boolean', description: 'set_application_status：用户明确要求跳过状态机校验时设 true。' },
        skill: {
          type: 'object',
          description: 'add_skill：{name,difficulty,proposedBy,reason,status}。proposedBy=ai 时 reason 必填。',
          additionalProperties: true,
        },
        exam: {
          type: 'object',
          description: 'record_exam：{score,passed,questions,weakPoints,advice}。passed=true 才会把技能标为完成。',
          additionalProperties: true,
        },
        application: {
          type: 'object',
          description: 'add_application：{jobId 或 company+title, status, note}。',
          additionalProperties: true,
        },
        label: {
          type: 'string',
          description: 'add_term：要加入标签词表的词（用户手动添加技能时会同步进来）。',
        },
        fromId: { type: 'string', description: 'merge_terms：要合并掉的词条 id。' },
        intoId: { type: 'string', description: 'merge_terms：合并到哪个词条 id。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: textOutput((args, value) => {
      if (value && value.error) return `写入失败：${value.error}`;
      return safeJson(value);
    }),
    async execute(args) {
      const { store } = await loadStore(rootCtx);
      const confirmed = args.confirmed === true;
      const actor = confirmed ? 'user' : 'ai';
      const ctxArg = { actor, confirmed };

      switch (args.action) {
        case 'upsert_tags': {
          if (!Array.isArray(args.tags) || !args.tags.length) throw new Error('upsert_tags 需要 tags 数组');
          const out = [];
          const demoted = [];
          for (const t of args.tags) {
            // ⚠️ 防「推断洗白」：confirmed 是调用级开关，而 addProfileTag 的落库规则是
            //   confirmed = (source === 'user_explicit') ? true : ctx.confirmed
            // 于是一次混批 + confirmed:true 会把 ai_inferred 的推断标签一起标成已确认，
            // pendingConfirmation 归零 —— 推断静默混进事实层，后续结论全被污染。
            // 因此这里**逐条**判定：ai_inferred（或 source 缺失）绝不继承调用级 confirmed，
            // 只能靠该条自己的 `confirmed: true`（= 用户逐条点头）才落为已确认。
            const inferred = !t.source || t.source === 'ai_inferred';
            const perTag = t.confirmed === true ? true : (inferred ? false : confirmed);
            if (inferred && confirmed === true && t.confirmed !== true) demoted.push(t.label);
            out.push(await store.addProfileTag(t, {
              actor: perTag ? 'user' : 'ai',
              confirmed: perTag,
            }));
          }
          return {
            written: out.length,
            tags: out,
            ...(demoted.length
              ? {
                  warning:
                    `以下 ${demoted.length} 条 source=ai_inferred 的标签**未被确认**，已落为待确认（不参与正式结论）：`
                    + `${demoted.join('、')}。`
                    + '若用户确实逐条点头过，请单独对该条写 confirmed:true 后重发。',
                }
              : {}),
          };
        }

        case 'update_tag':
          return await store.updateProfileTag(req(args.id, 'id'), args.patch || {}, ctxArg);

        case 'delete_tag':
          return await store.deleteProfileTag(req(args.id, 'id'), ctxArg);

        case 'set_objective':
          return { objective: await store.setProfileObjective(req(args.objective, 'objective'), ctxArg) };

        case 'upsert_jobs': {
          if (!Array.isArray(args.jobs) || !args.jobs.length) throw new Error('upsert_jobs 需要 jobs 数组');
          const r = await store.upsertJobs(args.jobs, { actor: 'ai' });
          return { created: r.created, updated: r.updated, unchanged: r.unchanged, items: r.items };
        }

        case 'update_job':
          return await store.updateJob(req(args.id, 'id'), args.patch || {}, { actor });

        case 'delete_job':
          return await store.deleteJob(req(args.id, 'id'), { actor });

        case 'tag_job': {
          // 需求（v1.5）：JD 的技术标签由 Agent 读 JD 后自己给，不再靠关键词匹配。
          // 词表会随打标长大，且优先复用已有词 → 抑制同义词分裂。
          if (!Array.isArray(args.tags) || !args.tags.length) {
            // 报错时顺带把已有词表回给模型，方便它下一次优先复用
            const existing = await store.readTaxonomy();
            return {
              error: 'tag_job 需要 tags 数组，且至少 1 个（用户要求每条 JD 至少 1 个技能点）。',
              hint: '请先读 career_read 的 taxonomy 动作看已有词表，优先复用已有词，不够描述这条 JD 时再新增。',
              existingTerms: existing.terms.slice(0, 200).map((t) => t.label),
            };
          }
          const r = await store.tagJob(req(args.id, 'id'), args.tags, { actor: 'ai' });
          return {
            jobId: r.job.id,
            tags: r.tags,
            createdTerms: r.created,
            reusedTerms: r.reused,
            note: r.created.length
              ? `新增了 ${r.created.length} 个词条：${r.created.join('、')}`
              : '全部复用已有词表',
          };
        }

        case 'add_term':
          return await store.addTaxonomyTerm(req(args.label, 'label'), { actor });

        case 'merge_terms':
          return await store.mergeTaxonomyTerms(
            req(args.fromId, 'fromId'), req(args.intoId, 'intoId'), { actor }
          );

        case 'add_application':
          if (!confirmed) throw new Error('新增投递属于用户事实数据，必须 confirmed=true（请先向用户确认）');
          return await store.addApplication(args.application || {}, ctxArg);

        case 'set_application_status':
          if (!confirmed) throw new Error('变更投递状态必须 confirmed=true（隐式推断请先向用户确认）');
          return await store.setApplicationStatus(
            req(args.id, 'id'), req(args.status, 'status'), args.note,
            { actor, confirmed, force: args.force === true }
          );

        case 'update_application':
          return await store.updateApplication(req(args.id, 'id'), args.patch || {}, ctxArg);

        case 'delete_application':
          return await store.deleteApplication(req(args.id, 'id'), { actor });

        case 'add_skill':
          if (!confirmed) throw new Error('新增技能必须 confirmed=true（隐式推断或 AI 提议请先向用户确认）');
          return await store.addSkill(args.skill || {}, ctxArg);

        case 'update_skill': {
          const patch = { ...(args.patch || {}) };
          if (args.status !== undefined) patch.status = args.status;
          return await store.updateSkill(req(args.id, 'id'), patch, ctxArg);
        }

        case 'delete_skill':
          return await store.deleteSkill(req(args.id, 'id'), { actor });

        case 'record_exam':
          if (!confirmed) throw new Error('记录考核结果必须 confirmed=true');
          return await store.recordExam(req(args.id, 'id'), args.exam || {}, ctxArg);

        case 'rebuild_graph':
          return await store.buildGraph({ actor: 'ai' });

        default:
          throw new Error(`未知的 action：${args.action}`);
      }
    },
  };
}

function req(v, name) {
  if (v === undefined || v === null || v === '') throw new Error(`缺少必填参数：${name}`);
  return v;
}

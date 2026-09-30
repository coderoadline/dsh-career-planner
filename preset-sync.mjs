/**
 * 把插件包内的 `presets/` 同步到 DSH 的预设发现根目录。
 *
 * ── 为什么需要这一步 ─────────────────────────────────────────────────────
 * DSH 的 agent 预设只从固定位置发现：`<DSH_HOME>/.agent-presets/`（以及随
 * harness 发行的内置预设）。用户装完插件后，若还要手动把预设拷进那个目录，
 * 就谈不上"一条命令装好"。
 *
 * 参照 `@linxin666/dsh-liangshen` 的做法：预设随插件包分发，插件在 Host 启动
 * 时把包内 `presets/` 同步到 `<DSH_HOME>/.agent-presets/`。于是用户只需
 * `dsh plugin add <包名>`，预设就自动出现在会话预设选择器里。
 *
 * ── 同步语义 ────────────────────────────────────────────────────────────
 *   · **幂等**：目标树与源树逐字节一致 → 跳过，不做无谓写盘。
 *   · **只动自己拥有的预设 id**：`OWNED_PRESET_IDS` 之外的目录（用户自己写的
 *     预设、别的插件同步进来的预设）**绝不触碰**。
 *   · **覆盖**：自己拥有的 id 若已存在，按源树覆盖（这样升级插件后重启即更新）。
 *   · **清理**：目标树里源树没有的文件会被删除，避免旧版残留文件污染新预设。
 *
 * ── 为什么不直接用 fs.cpSync ─────────────────────────────────────────────
 * Node 22 在 Windows 上，`fs.cpSync(..., {recursive:true})` 遇到源路径含非
 * ASCII 字符（如中文用户目录）会**致命崩溃**（STATUS_STACK_BUFFER_OVERRUN，
 * 不抛 JS 异常）：nodejs/node#54476。本文件因此用逐条目原语手写递归拷贝，
 * 与 dsh-liangshen 的取舍一致。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

/** 本插件拥有的预设 id —— 只有这些目录会被同步/覆盖/清理。 */
export const OWNED_PRESET_IDS = ['career-planner'];

/** 全局数据目录名。放在插件包**之外**，这样更新插件不会覆盖用户数据。 */
export const DATA_DIR_NAME = 'dsh-career-planner-data';

/**
 * 全局数据目录的候选根（按优先级）。
 *
 * 为什么不用会话工作区：工作区随会话变化，用户会看到"数据不见了"；
 * 而放在插件包内又会被 `dsh plugin add` 整体替换掉。所以固定放一个外部目录。
 *
 * 优先级：E → D → 其它非 C 盘 → C（C 通常是系统盘，可用空间最紧张）。
 * 非 Windows 没有盘符概念，直接用用户目录。
 *
 * @param {string} [platform] 平台（测试注入用）
 * @returns {string[]} 绝对路径候选
 */
export function dataRootCandidates(platform = process.platform, home = homedir()) {
  const name = DATA_DIR_NAME;
  // 非 Windows 没有盘符；直接用用户目录。
  // 注意用正斜杠拼接 —— 在 Windows 上跑 path.join('/Users/me', x) 会产出
  // '\Users\me\x'，把 POSIX 绝对路径毁掉。
  if (platform !== 'win32') return [`${home.replace(/\/+$/, '')}/${name}`];

  const drives = [];
  // E 优先，其次 D，再是其它非 C 盘，最后 C
  for (const letter of ['E', 'D']) drives.push(`${letter}:\\`);
  for (const letter of 'FGHIJKLMNOPQRSTUVWXYZ') drives.push(`${letter}:\\`);
  drives.push('C:\\');

  return drives.map((d) => join(d, name));
}

/**
 * 解析全局数据根目录（供 `CareerStore` 当 workspaceRoot 用）。
 *
 * 语义：
 *   1. `CAREER_WORKSPACE` 环境变量显式指定 → 直接用（用户/测试的逃生口）
 *   2. 任一候选目录**已存在** → 用它（不新建、不搬家，保证数据不丢）
 *   3. 都不存在 → 按优先级在第一个**可写**的盘上创建
 *   4. 全失败 → 用户目录下的同名目录兜底
 *
 * @param {NodeJS.ProcessEnv} [env] 环境变量（测试注入用）
 * @param {string} [platform] 平台（测试注入用）
 * @param {string} [home] 用户目录（测试注入用）
 * @returns {string} 绝对路径
 */
export function resolveDataRoot(env = process.env, platform = process.platform, home = homedir()) {
  const explicit = env && env.CAREER_WORKSPACE;
  if (explicit !== undefined && String(explicit).trim() !== '') {
    return resolve(String(explicit).trim());
  }

  const candidates = dataRootCandidates(platform, home);

  // ① 已存在的直接复用
  for (const dir of candidates) {
    try { if (existsSync(dir)) return dir; } catch { /* 盘不可访问，跳过 */ }
  }
  // ② 都不存在 → 建第一个能建的
  for (const dir of candidates) {
    try { mkdirSync(dir, { recursive: true }); return dir; } catch { /* 无权限或盘不存在，试下一个 */ }
  }
  // ③ 兜底：用户目录下的同名目录（C 盘根通常没写权限，所以用家目录）
  const fallback = platform === 'win32'
    ? join(home, DATA_DIR_NAME)
    : dataRootCandidates(platform, home)[0];
  try { mkdirSync(fallback, { recursive: true }); } catch { /* 交给下游报错 */ }
  return fallback;
}

/**
 * 解析 DSH home 目录。
 *
 * 与 dsh-liangshen / dsh-home-paths 的契约一致：`DSH_HOME` 环境变量优先
 * （支持 `~` 展开；相对路径按进程 cwd 解析），否则回退 `<用户目录>/.dsh`。
 *
 * @param {NodeJS.ProcessEnv} [env] 环境变量（测试注入用）
 * @param {string} [home] 平台用户目录（测试注入用）
 * @returns {string} 绝对路径
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const raw = env && env.DSH_HOME;
  if (raw !== undefined && String(raw).trim() !== '') {
    let expanded = String(raw).trim();
    if (expanded === '~') expanded = home;
    else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
      expanded = join(home, expanded.slice(2));
    }
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
  }
  return join(home, '.dsh');
}

/** 递归列出目录下所有文件（相对路径）。 */
function filesUnder(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(root);
  return out;
}

/** 逐字节比较两个文件是否相同（先比大小，再比内容）。 */
function sameFile(a, b) {
  const sa = statSync(a);
  const sb = statSync(b);
  if (sa.size !== sb.size) return false;
  return readFileSync(a).equals(readFileSync(b));
}

/**
 * 删除 `root` 下不在 `keep`（相对路径集合）里的文件，
 * 再自底向上删除因此变空的目录 —— 始终限制在 `root` 内，兄弟预设不受影响。
 */
function pruneExtras(root, keep) {
  const parents = new Set();
  for (const file of filesUnder(root)) {
    if (!keep.has(relative(root, file))) {
      parents.add(dirname(file));
      rmSync(file, { force: true });
    }
  }
  for (const start of parents) {
    let dir = start;
    while (dir !== undefined && relative(root, dir) !== '') {
      if (existsSync(dir) && readdirSync(dir).length === 0) {
        rmSync(dir, { recursive: true, force: true });
        dir = dirname(dir);
      } else {
        dir = undefined;
      }
    }
  }
}

/** 递归拷贝目录树，并保留源文件的 mtime。 */
function copyTreeSync(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    const source = join(sourceDir, entry);
    const target = join(targetDir, entry);
    const stat = statSync(source);
    if (stat.isDirectory()) {
      copyTreeSync(source, target);
    } else {
      copyFileSync(source, target);
      try { utimesSync(target, stat.atime, stat.mtime); } catch { /* mtime 保留失败不影响正确性 */ }
    }
  }
}

/**
 * 幂等同步一个预设目录：`sourceDir` → `targetDir`。
 *
 * @returns {'synced'|'current'} 本次是否真的写了盘
 */
export function syncOnePreset(sourceDir, targetDir) {
  const sourceFiles = filesUnder(sourceDir);
  const sourceSet = new Set(sourceFiles.map((f) => relative(sourceDir, f)));

  // 目标是文件而非目录 → 先清掉，否则拷贝会撞类型
  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    rmSync(targetDir, { recursive: true, force: true });
  }

  if (!existsSync(targetDir)) {
    copyTreeSync(sourceDir, targetDir);
    pruneExtras(targetDir, sourceSet);
    return 'synced';
  }

  // 目标已存在：逐个比对，找出第一处差异即可判定需要重写
  let dirty = false;
  for (const file of sourceFiles) {
    const dest = join(targetDir, relative(sourceDir, file));
    if (!existsSync(dest)) { dirty = true; break; }
    if (!sameFile(file, dest)) { dirty = true; break; }
  }
  // 目标里有源没有的残留文件 → 也算脏（需要清理）
  if (!dirty) {
    for (const file of filesUnder(targetDir)) {
      if (!sourceSet.has(relative(targetDir, file))) { dirty = true; break; }
    }
  }
  if (!dirty) return 'current';

  // 先删目标独有条目（避免文件/目录类型冲突），再拷贝，再清理一次
  pruneExtras(targetDir, sourceSet);
  copyTreeSync(sourceDir, targetDir);
  pruneExtras(targetDir, sourceSet);
  return 'synced';
}

/**
 * 把 `sourceRoot` 下所有预设目录同步进 `targetRoot`。
 *
 * 只处理 `OWNED_PRESET_IDS` 里列出的 id —— 其它目录一律不动。
 *
 * @param {string} sourceRoot 插件包内的 `presets/` 目录
 * @param {string} targetRoot DSH 的预设发现根目录（`<DSH_HOME>/.agent-presets`）
 * @param {string[]} [owned] 本插件拥有的预设 id
 * @returns {{synced:string[], current:string[], failed:{id:string,error:string}[]}}
 */
export function syncPresetTrees(sourceRoot, targetRoot, owned = OWNED_PRESET_IDS) {
  const result = { synced: [], current: [], failed: [] };
  if (!existsSync(sourceRoot)) {
    result.failed.push({ id: '(source)', error: `插件包内找不到 presets/ 目录：${sourceRoot}` });
    return result;
  }
  try {
    mkdirSync(targetRoot, { recursive: true });
  } catch (err) {
    result.failed.push({ id: '(target)', error: `无法创建预设目录 ${targetRoot}：${(err && err.message) || err}` });
    return result;
  }

  for (const id of owned) {
    const source = join(sourceRoot, id);
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      result.failed.push({ id, error: `插件包内缺少预设目录 presets/${id}` });
      continue;
    }
    try {
      const outcome = syncOnePreset(source, join(targetRoot, id));
      if (outcome === 'synced') result.synced.push(id);
      else result.current.push(id);
    } catch (err) {
      result.failed.push({ id, error: (err && err.message) || String(err) });
    }
  }
  return result;
}

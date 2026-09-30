/**
 * dsh-career-planner — Client 半边
 *
 * v1.6.0：注册为**官方侧边栏面板**（`sidebar.panellist` 图标 + `main` 面板）。
 * 点侧边栏的 🎯 图标即可打开，和「上下文」「浏览器」那些面板同一机制。
 *
 * 历史：v1.5.x 及以前是挂在 `shell.overlay` 上的可拖动缩放悬浮窗；
 * 因为窗口定位/滚动/弹窗跟随问题反复出 bug，改为官方面板，窗口管理交给外壳。
 *
 * ⚠️ 三条硬约束（历史上各导致过一次崩溃，勿违反）：
 *   1. 所有 hooks 必须在任何 early return 之前 —— 否则 React #310，
 *      表现为"整个悬浮窗闪一下就消失"。
 *   2. Tab 组件的 key 只能是稳定标识，不能带会变的 ver —— 否则每次写入
 *      都卸载重建整个 Tab。
 *   3. data 可能为 null（请求中/失败），解引用前必须兜底。
 *
 * 本版本（v1.2）新增：
 *   - 需求1：去投递 → 直接进入已投递流程；收起态即可见状态与最后更新时间
 *   - 需求2：状态只许向前，笔试后不能退回已投递
 *   - 需求3：撤销上一次状态变更
 *   - 需求4：投递栏按状态/公司筛选 + 关键词搜索
 *   - 需求5：所有计数统一用 () 包裹
 *   - 需求6：删除/去投递/编辑等关键按钮不展开也能看到
 *   - 需求7：编辑表单每一栏都有说明标签
 *   - 需求8：Toast / Modal 移到窗口顶部
 *   - 需求9：JD 15 天自动过期 → 检测失效 → 待删除 → 一天后清理
 *   - 需求10：每个 JD 可一键「问 AI」，把 JD 注入聊天输入框
 *   - 需求11：技术栈与业务能力合并，彩色气泡可点击筛选
 *   - 需求12：画像页视觉升级（卡片分组 + 维度色条 + 概览统计）
 */

window.__ModuleLoader__.load({
  id: 'dsh-career-planner',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    // ───────────────────────── 常量 ─────────────────────────

    const LS_TAB = 'dsh-career-planner:tab';
    const API_PATH = '/dsh-career-planner/api';

    /** 时间范围筛选（需求 2 / 需求 9） */
    const TIME_FILTERS = [
      { key: 'all', label: '全部' },
      { key: '7', label: '近 7 天' },
      { key: '15', label: '近 15 天' },
      { key: '30', label: '近 30 天' },
      { key: 'expired', label: '已过期' },
    ];

    /** 技术标签颜色（需求 11：不同技术栈用特有的颜色做气泡） */
    function tagColor(hue, alpha) {
      const hh = typeof hue === 'number' ? hue : 220;
      return alpha === undefined
        ? `hsl(${hh}, 62%, 45%)`
        : `hsla(${hh}, 68%, 46%, ${alpha})`;
    }
    function tagStyle(hue, active) {
      const hh = typeof hue === 'number' ? hue : 220;
      return active
        ? {
          background: tagColor(hh), color: '#fff',
          border: `1px solid ${tagColor(hh)}`,
        }
        : {
          background: `hsla(${hh}, 70%, 48%, 0.13)`,
          color: tagColor(hh),
          border: `1px solid hsla(${hh}, 70%, 48%, 0.32)`,
        };
    }

    // ───────────────────────── Host RPC ─────────────────────────

    async function call(method, args) {
      let res;
      try {
        res = await fetch(API_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, args: args ?? {} }),
          credentials: 'same-origin',
        });
      } catch (err) {
        throw new Error('无法连接职业工作台后端（请确认插件已启用）：' + ((err && err.message) || err));
      }
      if (!res.ok) throw new Error(`后端返回 HTTP ${res.status}`);
      let data;
      try { data = await res.json(); }
      catch { throw new Error('后端返回的不是合法 JSON'); }
      if (!data || data.ok !== true) throw new Error((data && data.error) || '未知错误');
      return data.value;
    }

    function useRpc(method, args, deps) {
      const [state, setState] = useState({ loading: true, data: null, error: null });
      const reload = useCallback(async () => {
        setState((s) => ({ ...s, loading: true }));
        try {
          const data = await call(method, args);
          setState({ loading: false, data, error: null });
        } catch (err) {
          setState({ loading: false, data: null, error: (err && err.message) ? err.message : String(err) });
        }
      }, deps || []);
      useEffect(() => { reload(); }, [reload]);
      return { ...state, reload, setState };
    }

    // ───────────────────────── 时间工具（需求 2） ─────────────────────────

    function daysSince(iso) {
      const t = Date.parse(iso || '');
      if (!Number.isFinite(t)) return null;
      return (Date.now() - t) / 86400000;
    }

    function relTime(iso) {
      const t = Date.parse(iso || '');
      if (!Number.isFinite(t)) return '—';
      const diff = Date.now() - t;
      const min = Math.floor(diff / 60000);
      if (min < 1) return '刚刚';
      if (min < 60) return `${min} 分钟前`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `${hr} 小时前`;
      const d = Math.floor(hr / 24);
      if (d < 30) return `${d} 天前`;
      return String(iso).slice(0, 10);
    }

    /**
     * 「还有多久」——给**未来**时间用（如 pendingDeleteAt 的宽限期）。
     * relTime 对未来时间会算成负数 → `min < 1` → 显示「刚刚」，
     * 于是「待删除 · 刚刚后清」这种荒唐文案就出来了。这个函数专门解决它。
     */
    function untilTime(iso) {
      const t = Date.parse(iso || '');
      if (!Number.isFinite(t)) return null;
      const diff = t - Date.now();
      if (diff <= 0) return '已到期';
      const min = Math.floor(diff / 60000);
      if (min < 60) return `${Math.max(1, min)} 分钟`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `${hr} 小时`;
      const d = Math.floor(hr / 24);
      if (d < 30) return `${d} 天`;
      return String(iso).slice(0, 10);
    }

    /**
     * 距离某个「日期」（YYYY-MM-DD）还剩几天。
     * 需求：技能卡片外部只显示「距结束还有 N 天」，**不直接甩一个日期**。
     * 已经过了返回负数，界面据此显示「已超期 N 天」。
     */
    function daysLeft(dateStr) {
      const d = String(dateStr || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
      const end = Date.parse(`${d}T00:00:00`);
      if (!Number.isFinite(end)) return null;
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      return Math.round((end - start) / 86400000);
    }

    function fullTime(iso) {
      if (!iso) return '—';
      return String(iso).slice(0, 16).replace('T', ' ');
    }

    /** 按时间范围过滤（需求 2 / 需求 9） */
    function inTimeRange(job, range) {
      if (range === 'all') return true;
      if (range === 'expired') return job.status === 'expired' || job.status === 'pending_delete';
      const d = daysSince(job.updatedAt || job.collectedAt);
      if (d === null) return false;
      return d <= Number(range);
    }

    // ───────────────────── 需求 10：把内容注入聊天输入框 ─────────────────────

    /**
     * 找到聊天输入框（textarea 或 contenteditable）。
     *
     * 为什么用 DOM 而不是 Service：客户端没有"往输入框塞草稿"的公开服务，
     * 而 dsh-obsidian-bridge 已经证明在这套 UI 里直接操作输入框是可行的。
     *
     * ⚠️ 「检测有没有内容」和「往里写」必须用**同一个函数**找到**同一个元素**，
     *    否则会出现"检测的是 A 框、写的却是 B 框"这种查不出来的怪事。
     */
    function findComposer() {
      const sels = [
        'textarea[placeholder]',
        '.dsh-composer textarea',
        'form textarea',
        'textarea',
        '[contenteditable="true"]',
      ];
      for (const s of sels) {
        const list = Array.from(document.querySelectorAll(s));
        // 选最靠下、面积最大的那个（聊天输入框通常在页面底部）
        const cand = list
          .filter((n) => n.offsetParent !== null && n.getBoundingClientRect().width > 120)
          .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
        if (cand) return cand;
      }
      return null;
    }

    /** 读出输入框当前的内容（空则返回 ''） */
    function readComposer() {
      const el = findComposer();
      if (!el) return '';
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value || '');
      return String(el.textContent || '').trim();
    }

    /**
     * 往输入框写字。
     * @param {string} text
     * @param {boolean} replace true=先清空再写（覆盖）；false=插到光标处
     *
     * ⚠️ contenteditable **不能**用 `el.textContent = text`：
     *    富文本编辑器（React 受控）在下一次渲染时会把旧内容原样恢复回来，
     *    表现为"覆盖没生效"。可靠做法是走浏览器原生编辑命令 ——
     *    `selectAll` 选中全部 → `insertText` 用新文本替换选区，
     *    这样编辑器的内部状态也会同步更新。
     */
    function writeComposer(text, replace) {
      const el = findComposer();
      if (!el) return false;
      el.focus();

      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        // React 受控组件必须走**原型上的原生 setter**，否则 onChange 收不到，
        // 值会在下次渲染被冲掉
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        const next = text;
        if (setter) setter.call(el, next);
        else el.value = next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // contenteditable（富文本编辑器）：靠原生编辑命令做「清空 + 写入」
        try {
          el.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);   // 先真删掉，保证不叠加
          const ok = document.execCommand('insertText', false, text);
          if (!ok) return false;                          // 插不进去就如实报失败
        } catch { return false; }

        // ⚠️ 这里**绝不能**再手动 dispatch 一个 input 事件。
        //    execCommand 执行时浏览器**已经触发过原生 input** 了；
        //    再补一个 `new InputEvent('input', {data: text})`，编辑器的
        //    onInput 处理器会把它当成"用户又插入了一段"，于是内容变成两份。
        //    实测特征：两份换行表现不同（一份换行丢失、一份正常）——
        //    正是"DOM 直改"与"编辑器自己插入"两条通道各写一次留下的痕迹。
        //    这条 bug 让「问 AI」的提示词被注入两次。
      }
      // 光标放到末尾
      try {
        const len = text.length;
        if (el.setSelectionRange) el.setSelectionRange(len, len);
      } catch { /* contenteditable 可能不支持 */ }

      // 自检：读回来数一遍，出现多次就说明又被插重了 —— 清空重写一次。
      {
        const got = readComposer();
        let hits = 0; let from = 0;
        for (;;) {
          const at = got.indexOf(text, from);
          if (at < 0) break;
          hits += 1; from = at + text.length;
        }
        if (hits > 1) {
          try {
            el.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            document.execCommand('insertText', false, text);
          } catch { /* 实在不行就留着 */ }
        }
      }
      return true;
    }

    /** 注入（不覆盖，直接替换整个内容）—— 保留旧签名给兜底路径用 */
    function fillComposer(text) {
      return writeComposer(text, true);
    }

    /** 注入失败时的兜底：复制到剪贴板 */
    async function copyToClipboard(text) {
      // ✅ 新增：参数判断，如果text是undefined/null直接返回false
      if (text === undefined || text === null) {
        return false;
      }
      // 转字符串，防止传入数字、对象等异常类型
      const copyText = String(text);

      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(copyText);
          return true;
        }
      } catch (err) {
        console.warn('clipboard api失败', err);
      }

      // 降级方案
      const ta = document.createElement('textarea');
      ta.value = copyText;
      ta.style.cssText = `position:fixed;left:-9999px;top:0;opacity:0;`;
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e) {
        ok = false;
      }
      document.body.removeChild(ta);
      return ok;
    }

    /**
     * 聊天区当前有没有内容（已有消息）。
     *
     * 用于「注入提示词」前的确认：如果当前会话已经有对话，
     * 往输入框里塞东西可能会覆盖/打断用户的上下文，先问一句。
     *
     * 判据（尽量不依赖具体 class 名，靠结构 + 角色标记）：
     *   · 消息气泡通常带 user/assistant 之类的角色标记或头像；
     *   · 排除掉输入框自己、空状态提示。
     */
    function chatHasMessages() {
      try {
        // 常见的气泡选择器（覆盖几种 DSH 版本可能用的写法）
        const sels = [
          '[data-message-role]',
          '[data-role]',
          '.msg',
          '.message',
          '[class*="user-msg"]',
          '[class*="assistant"]',
          '[class*="bubble"]',
        ];
        for (const s of sels) {
          const n = document.querySelectorAll(s);
          if (n.length > 0) return true;
        }
        // 兜底：如果主内容区里有很多 <p>/<pre> 文本块（超过 6 段），大概率有对话
        const main = document.querySelector('main, [class*="conversation"], [class*="messages"]');
        if (main) {
          const paras = main.querySelectorAll('p, pre, li');
          if (paras.length > 6) return true;
        }
      } catch { /* 探测失败按"没有消息"处理，不阻塞注入 */ }
      return false;
    }

    /**
     * 点一下 DSH 的「新会话 / 新聊天」按钮。
     * 找不到就返回 false，让调用方走"当前会话"或提示用户手动新建。
     */
    function startNewChat() {
      try {
        const sels = [
          'button[data-testid*="new-chat"]',
          '[data-testid*="new"]',
          'button[aria-label*="新会话"]',
          'button[aria-label*="新建"]',
          'button[title*="新会话"]',
          'button[title*="新建会话"]',
          'button[title*="新聊天"]',
        ];
        for (const s of sels) {
          const b = document.querySelector(s);
          if (b) { b.click(); return true; }
        }
        // 退一步：找文本像"新会话/新建/新对话"的按钮
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const hit = btns.find((b) => /^(新会话|新建会话|新建|新对话|新聊天|\+ 新会话)$/.test(
          (b.textContent || '').trim(),
        ));
        if (hit) { hit.click(); return true; }
      } catch { /* 找不到就算了 */ }
      return false;
    }

    /**
     * 注入提示词：**直接新建一个会话**，再把提示词放进输入框。
     *
     * v1.5.6 简化：之前是「有内容就问用户 —— 用当前会话还是新建？」，
     * 两级弹窗（还要再问覆不覆盖）。用户反馈"逻辑别太复杂了"，
     * 改成**无条件新建会话**：不碰你正在进行的对话，也不会覆盖你写了一半的字。
     *
     * @param {string} text
     * @param {(o:object)=>Promise<any>} [ask] 只用于"自动点不到新会话"时提示用户
     * @returns {Promise<boolean>} 是否已注入
     */
    async function confirmThenFill(text, ask) {
      // 只有在"这里已经有对话或草稿"时才需要新建；
      // 空白会话直接注入，省掉一次多余的点击。
      //const busy = chatHasMessages() || !!readComposer().trim();
      //if (!busy) return fillComposer(text);
    
      // if (!startNewChat()) {
      //   // 点不到「新建会话」按钮 → 告诉用户，让他自己点一下
      //   if (ask) {
      //     await ask({
      //       title: '请新建一个会话',
      //       message: '我没能自动点到「新会话」按钮。\n\n'
      //         + '请你点一下左上角的「新建会话」，然后我把这段提示词放进输入框。',
      //       confirmText: '知道了',
      //     });
      //   }
      //   return false;
      // }
      // 新会话是空的，直接注入（replace=true 保证干净）
      
      return copyToClipboard(text);
    }

    /** 为一个 JD 拼出「问 AI」的提问稿（需求 10） */
    function buildAskPrompt(job, meta) {
      // ⚠️ v1.5.6 修：原来这里同时输出「技术方向」和「技能要求」两行，
      // 但 v1.5.1 起 `job.skills` **就是**这条 JD 的技术标签（skills === tags），
      // 而 tags 又是 businessSkills 映射出来的中文名 —— 两者恒等，
      // 于是提示词里同一串词出现了两遍（4 条 JD 全部实测重复）。
      // 现在只保留一行，用 `skills`（用户可编辑的那份，也是权威的）。
      const skills = Array.isArray(job.skills) ? job.skills.join('、') : '';
      const lines = [
      `帮我分析这个岗位，我想知道：`,
      `1. 它到底在招什么样的人？核心考察什么能力？`,
      `2. 以我现在的画像和技能，投它的匹配度如何、最大短板是什么？`,
      `3. 如果要准备面试，优先补哪几块？`,
      ``,
      `【岗位信息】`,
      `公司：${job.company || '—'}`,
      `岗位：${job.title || '—'}`,
      job.city ? `城市：${job.city}` : null,
      skills ? `技术方向：${skills}` : null,
      job.url ? `链接：${job.url}` : null,
      job.requirements ? `【任职要求】\n ${job.requirements}` : null,
      job.description ? `【岗位描述】\n ${job.description}` : null,].filter(Boolean).join('\n');
      return lines;
}


    // ───────────────────────── 设计系统（需求 6 / 12） ─────────────────────────

    const T = { radius: 8, radiusLg: 12, font: 12, fontSm: 11 };

    const P = {
      hint: { fontSize: T.fontSm, color: 'var(--dsw-alias-label-secondary)', padding: '16px 0', textAlign: 'center' },
      row: { display: 'flex', alignItems: 'center', gap: 6 },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: T.radiusLg,
        padding: 12,
        marginBottom: 8,
        background: 'var(--dsw-alias-bg-layer-1)',
        transition: 'border-color .15s ease, box-shadow .15s ease',
      },
      cardHover: {
        borderColor: 'var(--dsw-alias-border-l2)',
        boxShadow: '0 2px 10px rgba(0,0,0,.08)',
      },
      sectionTitle: {
        fontSize: T.font, fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
        display: 'flex', alignItems: 'center', gap: 6,
      },
      muted: { fontSize: T.fontSm, color: 'var(--dsw-alias-label-secondary)' },
    };

    /** 卡片：悬停有反馈（需求 6） */
    function Card({ children, style, onClick, highlight, dim }) {
      const [hover, setHover] = useState(false);
      const s = {
        ...P.card,
        ...(highlight ? { borderColor: 'var(--dsw-alias-state-warn-primary)' } : {}),
        ...(dim ? { opacity: 0.62 } : {}),
        ...(hover && onClick ? P.cardHover : {}),
        ...(onClick ? { cursor: 'pointer' } : {}),
        ...(style || {}),
      };
      return h('div', {
        style: s,
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      }, children);
    }

    function Btn({ children, onClick, kind = 'default', title, disabled, size = 'md', style }) {
      const [hover, setHover] = useState(false);
      const kinds = {
        primary: { border: '1px solid var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)', color: '#fff' },
        default: { border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-primary)' },
        danger: { border: '1px solid transparent', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)' },
      };
      const pads = { sm: '3px 8px', md: '5px 11px' };
      return h('button', {
        onClick: disabled ? undefined : onClick,
        title, disabled,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          ...(kinds[kind] || kinds.default),
          borderRadius: T.radius,
          padding: pads[size],
          fontSize: T.font,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.45 : (hover ? 0.86 : 1),
          whiteSpace: 'nowrap',
          transition: 'opacity .15s ease, background .15s ease',
          ...(style || {}),
        },
      }, children);
    }

    function Input({ value, onChange, placeholder, style, type = 'text', onKeyDown, autoFocus }) {
      return h('input', {
        type, value: value ?? '', placeholder, autoFocus,
        onChange: (e) => onChange(e.target.value),
        onKeyDown,
        style: {
          width: '100%', boxSizing: 'border-box', padding: '6px 9px', fontSize: T.font,
          borderRadius: T.radius, border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
          outline: 'none', ...(style || {}),
        },
      });
    }

    function TextArea({ value, onChange, placeholder, rows = 3, style }) {
      return h('textarea', {
        value: value ?? '', placeholder,
        onChange: (e) => onChange(e.target.value),
        rows,
        style: {
          width: '100%', boxSizing: 'border-box', fontSize: T.font, padding: 8,
          borderRadius: T.radius, border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
          outline: 'none', resize: 'vertical', fontFamily: 'inherit', ...(style || {}),
        },
      });
    }

    function Select({ value, onChange, options, style }) {
      return h('select', {
        value: value ?? '',
        onChange: (e) => onChange(e.target.value),
        style: {
          padding: '6px 8px', fontSize: T.font, borderRadius: T.radius,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
          outline: 'none', ...(style || {}),
        },
      }, options.map((o) => h('option', { key: o.value, value: o.value }, o.label)));
    }

    function Tag({ children, tone = 'default', title }) {
      const tones = {
        default: ['var(--dsw-alias-bg-layer-2)', 'var(--dsw-alias-label-secondary)'],
        warn: ['color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent)', 'var(--dsw-alias-state-warn-primary)'],
        ok: ['color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent)', 'var(--dsw-alias-state-success-primary)'],
        err: ['color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent)', 'var(--dsw-alias-state-error-primary)'],
        brand: ['color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)', 'var(--dsw-alias-brand-primary)'],
      };
      const [bg, fg] = tones[tone] || tones.default;
      return h('span', {
        title,
        style: {
          background: bg, color: fg, borderRadius: 5, padding: '2px 7px',
          fontSize: 10.5, whiteSpace: 'nowrap', fontWeight: 500, display: 'inline-block',
        },
      }, children);
    }

    /**
     * 可点选的筛选胶囊。
     * 需求 5：计数统一用 (n) 包裹，而不是裸数字。
     */
    function Chip({ children, active, onClick, count, hue, title }) {
      const [hover, setHover] = useState(false);
      const colored = typeof hue === 'number';
      const base = colored ? tagStyle(hue, active) : {
        border: `1px solid ${active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
        background: active ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)' : 'transparent',
        color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
      };
      return h('button', {
        onClick,
        title,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          ...base,
          borderRadius: 999, padding: '3px 10px', fontSize: T.fontSm, cursor: 'pointer',
          whiteSpace: 'nowrap', fontWeight: active ? 600 : 400,
          opacity: hover && !active ? 0.78 : 1,
          transition: 'all .15s ease',
        },
      }, count === undefined ? children : `${children} (${count})`);
    }

    /** 需求 11：技术标签气泡——有专属颜色，点击可筛选 */
    function TechBubble({ id, label, labelAlt, hue, count, active, onClick, title }) {
      const [hover, setHover] = useState(false);
      return h('button', {
        onClick,
        // 需求 2（新一轮）：同时给出另一种语言的写法，中英用户都能对上号
        title: title || [
          label,
          labelAlt && labelAlt !== label ? `（${labelAlt}）` : '',
          count === undefined ? '' : ` · ${count} 个岗位`,
          onClick ? ' · 点击筛选相关 JD' : '',
        ].join(''),
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          ...tagStyle(hue, active),
          borderRadius: 999,
          padding: '3px 9px',
          fontSize: T.fontSm,
          cursor: onClick ? 'pointer' : 'default',
          whiteSpace: 'nowrap',
          fontWeight: active ? 600 : 500,
          opacity: hover && onClick && !active ? 0.78 : 1,
          transition: 'all .15s ease',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        },
      }, [
        h('span', { key: 'l' }, label),
        count === undefined ? null : h('span', {
          key: 'c',
          style: { opacity: 0.7, fontSize: 10 },
        }, `(${count})`),
      ]);
    }

    function Section({ title, right, children, count }) {
      return h('div', { style: { marginBottom: 16 } }, [
        h('div', {
          key: 'hd',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9, gap: 8 },
        }, [
          h('div', { key: 't', style: P.sectionTitle }, [
            h('span', { key: 'l' }, title),
            // 需求 5：计数用 () 包裹
            count !== undefined ? h(Tag, { key: 'c' }, `(${count})`) : null,
          ]),
          right ? h('div', { key: 'r', style: { ...P.row, flexShrink: 0 } }, right) : null,
        ]),
        h('div', { key: 'bd' }, children),
      ]);
    }

    function StateBox({ loading, error, empty, emptyText, emptyIcon, children, onRetry }) {
      if (loading) {
        return h('div', { style: P.hint }, [
          h('div', { key: 's', style: { fontSize: 20, marginBottom: 6, opacity: 0.5 } }, '◌'),
          h('div', { key: 't' }, '加载中…'),
        ]);
      }
      if (error) {
        return h('div', { style: { ...P.hint, color: 'var(--dsw-alias-state-error-primary)' } }, [
          h('div', { key: 'e', style: { marginBottom: 8 } }, `读取失败：${error}`),
          onRetry ? h(Btn, { key: 'r', onClick: onRetry }, '重试') : null,
        ]);
      }
      if (empty) {
        return h('div', { style: P.hint }, [
          emptyIcon ? h('div', { key: 'i', style: { fontSize: 26, marginBottom: 8, opacity: 0.35 } }, emptyIcon) : null,
          h('div', { key: 't' }, emptyText || '暂无数据'),
        ]);
      }
      return h('div', null, children);
    }

    // ───────────────────── 全局 Toast / Modal（需求 6 / 需求 8） ─────────────────────

    /**
     * Toast：放在**工作台的眉头**（与标题「职业规划工作台」同一水平线，水平居中）。
     *
     * v1.5.6 之前它贴在面板内容区顶部，而内容区是独立滚动容器，
     * 页面往下一划提示就跟着滚走了（用户反馈"添加成功看不到"）。
     * 现在本组件挂在**面板根节点**下、用 absolute 定位，因此
     * 既不会随内容滚动，又始终与标题齐平。
     * 定时自动消失（错误类多留一会儿），点任意处可关。
     */
    function ToastHost({ toasts, onDismiss }) {
      if (!toasts.length) return null;
      return h('div', {
        style: {
          position: 'absolute', left: 0, right: 0, top: 24, height: 37, zIndex: 50,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',                 // 容器不吃事件
          padding: '0 46px',                     // 给左右两端的标题/按钮让位
        },
        onClick: () => onDismiss && onDismiss(),
      }, h('div', {
        style: {
          pointerEvents: 'auto',
          display: 'flex', flexDirection: 'column', gap: 8,
          maxWidth: 380, width: '100%',
        },
      }, toasts.map((t) => {
        const fg = t.kind === 'error' ? 'var(--dsw-alias-state-error-primary)'
          : t.kind === 'success' ? 'var(--dsw-alias-state-success-primary)'
            : 'var(--dsw-alias-label-primary)';
        const icon = t.kind === 'error' ? '⚠' : t.kind === 'success' ? '✓' : 'ℹ';
        return h('div', {
          key: t.id,
          style: {
            pointerEvents: 'auto',
            padding: '11px 14px', borderRadius: T.radiusLg, fontSize: T.font,
            border: `1px solid ${t.kind === 'error' || t.kind === 'success'
              ? fg : 'var(--dsw-alias-border-l2)'}`,
            borderLeft: `3px solid ${t.kind === 'error' || t.kind === 'success'
              ? fg : 'var(--dsw-alias-brand-primary)'}`,
            background: 'var(--dsw-alias-bg-overlay)',
            color: fg,
            boxShadow: '0 10px 34px rgba(0,0,0,.34)',
            animation: 'cw-pop .18s ease',
            display: 'flex', alignItems: 'flex-start', gap: 8, lineHeight: 1.55,
          },
          onClick: (e) => { e.stopPropagation(); onDismiss && onDismiss(t.id); },
        }, [
          h('span', { key: 'i', style: { flexShrink: 0, fontWeight: 700 } }, icon),
          h('span', { key: 't', style: { flex: 1, wordBreak: 'break-word' } }, t.text),
        ]);
      })));
    }

    function ConfirmModal({ state, onClose }) {
      const [text, setText] = useState('');
      useEffect(() => {
        setText(state && state.defaultValue ? state.defaultValue : '');
      }, [state]);
      if (!state) return null;
      const {
        title, message, confirmText = '确定', cancelText = '取消',
        withInput, inputPlaceholder, danger, render, onConfirm,
      } = state;
      // v1.5.6：**相对工作台窗口居中**。
      // 用 absolute（不是 fixed）—— 本组件是面板根节点的直接子元素，
      // 面板根是 fixed，所以 absolute 的包含块就是工作台本身，弹窗正好落在窗口正中。
      // （早前用 fixed 会跑到视口正中，不在工作台里；用 absolute 放进滚动容器则会跟着内容滚走。）
      return h('div', {
        style: {
          position: 'absolute', inset: 0, zIndex: 40,
          background: 'rgba(0,0,0,.42)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '16px',
        },
        onClick: () => onClose(null),
      }, h('div', {
        onClick: (e) => e.stopPropagation(),
        style: {
          width: '100%', maxWidth: 400,
          background: 'var(--dsw-alias-bg-overlay)',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: T.radiusLg, padding: 16,
          boxShadow: '0 12px 40px rgba(0,0,0,.32)',
          animation: 'cw-pop .16s ease',
        },
      }, [
        h('div', {
          key: 't',
          style: {
            fontSize: 13, fontWeight: 600, marginBottom: 8,
            display: 'flex', alignItems: 'center', gap: 6,
            color: danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)',
          },
        }, [danger ? h('span', { key: 'i' }, '⚠') : null, h('span', { key: 'x' }, title)]),
        message ? h('div', { key: 'm', style: { ...P.muted, lineHeight: 1.6, marginBottom: 12, whiteSpace: 'pre-wrap' } }, message) : null,
        withInput ? h('div', { key: 'i', style: { marginBottom: 12 } },
          h(Input, { value: text, onChange: setText, placeholder: inputPlaceholder, autoFocus: true })) : null,
        // 可选的自定义内容（如选难度的下拉）。onConfirm 存在时由它决定返回值。
        render ? h('div', { key: 'c', style: { marginBottom: 12 } }, render(text, setText)) : null,
        h('div', { key: 'a', style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } }, [
          h(Btn, { key: 'c', onClick: () => onClose(null) }, cancelText),
          h(Btn, {
            key: 'k', kind: danger ? 'danger' : 'primary',
            onClick: () => onClose(onConfirm ? onConfirm(text) : (withInput ? text : true)),
          }, confirmText),
        ]),
      ]));
    }

    // ───────────────────────── 文案映射 ─────────────────────────

    function dimLabel(dims, key) {
      const d = (dims || []).find((x) => x.key === key);
      return d ? d.label : key;
    }
    function sourceLabel(s) {
      return s === 'user_explicit' ? '用户亲述' : s === 'resume_parsed' ? '简历解析' : 'AI 推断';
    }
    function sourceHint(s) {
      return s === 'user_explicit' ? '用户明确陈述，可直接采信'
        : s === 'resume_parsed' ? '从简历解析，需用户确认后才算数'
          : 'AI 推断，未确认前不参与正式结论';
    }
    function sourceTone(s) {
      return s === 'user_explicit' ? 'ok' : s === 'resume_parsed' ? 'brand' : 'warn';
    }

    /**
     * 技术标签 id → 展示名 / 颜色。
     *
     * v1.2（需求 11）：**不再在客户端硬编码一份映射**。
     * 词表唯一来源是数据层的 TECH_TAGS，Host 通过 getMeta 下发。
     * 这里只做一次缓存 + 兜底，避免前后端两份词表漂移（原技术债 O.8）。
     */
    let META_CACHE = null;

    /** 把 getMeta 的结果塞进缓存（App 启动时调一次） */
    function rememberMeta(m) { if (m) META_CACHE = m; }

    function techTag(id) {
      if (!id) return null;
      const list = (META_CACHE && META_CACHE.techTags) || [];
      return list.find((t) => t.id === id) || null;
    }
    /**
     * 展示名：优先用词表，兜底退回 id 本身。
     *
     * 需求 2（新一轮）：标签语言跟随 JD —— 中文 JD 显示中文名，英文 JD 显示英文名。
     * 词表数据来自 `getMeta.techTags`（Host 下发，含 `label` 与 `en`），
     * 客户端**不再自己维护一份映射**（那是已修掉的技术债 O.8）。
     *
     * @param {string} id 技术标签 id
     * @param {'zh'|'en'} [lang] 省略时给中文名
     */
    function bizLabel(id, lang) {
      const t = techTag(id);
      if (!t) return id;
      if (lang === 'en') return t.en || t.label;
      return t.label;
    }

    /**
     * 这条 JD 上某个标签该怎么显示。
     *
     * ★ 优先用 JD 自己存的文字（j.aiTags[].label）：
     *   以前只查词表，一旦引用悬空（词表清理 / 改名 / 迁移），
     *   界面就会漏出 tag-177f81c1 这种内部编号——用户完全看不懂。
     *   数据层 syncDerived() 会修悬空引用，这里是显示层的第二道保险。
     */
    function tagLabelFor(job, id) {
      const own = (job && job.aiTags || []).find((t) => t && t.id === id);
      if (own && own.label) return own.label;
      const t = techTag(id);
      if (!t) return String(id);
      return (job && job.tagLang === 'en') ? (t.en || t.label) : t.label;
    }

    /** 另一种语言的名字（悬停提示用）：同样优先用 JD 自存的中英文 */
    function tagLabelAlt(job, id) {
      const own = (job && job.aiTags || []).find((t) => t && t.id === id);
      const isEn = !!(job && job.tagLang === 'en');
      if (own) {
        const alt = isEn ? (own.labelZh || own.labelEn) : (own.labelEn || own.labelZh);
        if (alt && alt !== own.label) return alt;
      }
      return bizLabel(id, isEn ? 'zh' : 'en');
    }
    /** 色相：未知标签给一个稳定的兜底色，避免全是灰的 */
    function bizHue(id) {
      const t = techTag(id);
      if (t && typeof t.hue === 'number') return t.hue;
      let hash = 0;
      for (let i = 0; i < String(id).length; i += 1) hash = (hash * 31 + String(id).charCodeAt(i)) % 360;
      return hash;
    }

    /**
     * 需求 4（新一轮）：公司 / 城市这类"点标签筛选"的通用工具。
     *
     * 语义：`selected` 是**字符串数组**（多选）。
     *   - 空数组 = 不筛选
     *   - 点一下加入，再点一下移除
     * 早期版本用单个字符串 + 下拉框，只能选一个，且要展开才能选。
     */
    function toggleIn(arr, key) {
      const list = Array.isArray(arr) ? arr : [];
      return list.includes(key) ? list.filter((x) => x !== key) : [...list, key];
    }
    /** 命中判定：空数组视为全通过 */
    function matchAny(selected, value, fallback = '未填') {
      const list = Array.isArray(selected) ? selected : [];
      if (!list.length) return true;
      return list.includes(value || fallback);
    }

    /**
     * 城市串 → 城市数组。
     * 一个岗位可能同时面向多个城市，录入时写成「北京/上海/深圳」。
     * 筛选时它应当**同时属于**每一个城市，而不是被当成一个叫「北京/上海」的新城市。
     * 所以这里按分隔符拆开再比对。
     */
    const CITY_SPLIT_RE = /[/、,，·|]/;
    function splitCities(value, fallback = '未填') {
      const parts = String(value ?? '')
        .split(CITY_SPLIT_RE)
        .map((s) => s.trim())
        .filter(Boolean);
      return parts.length ? parts : [fallback];
    }
    /** 城市命中判定：选中项与该项的**任一**城市相同即命中；空数组视为全通过 */
    function matchCity(selected, value, fallback = '未填') {
      const list = Array.isArray(selected) ? selected : [];
      if (!list.length) return true;
      const mine = splitCities(value, fallback);
      return list.some((c) => mine.includes(c));
    }

    /**
     * 一行可点选的筛选标签（多选，再点取消）。
     * 公司 / 城市共用，保证两处交互一致。
     */
    function FilterTagRow({ label, all, selected, onToggle, onClear }) {
      const sel = Array.isArray(selected) ? selected : [];
      if (!all.length) return null;
      return h('div', {
        style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', marginBottom: 6 },
      }, [
        h('span', { key: 'l', style: { ...P.muted, fontSize: 11, flexShrink: 0 } }, `${label}：`),
        h(Chip, {
          key: '__all', active: sel.length === 0, onClick: onClear,
          count: all.reduce((s, x) => s + x.count, 0),
        }, '全部'),
        ...all.map((o) => h(Chip, {
          key: o.key,
          active: sel.includes(o.key),
          onClick: () => onToggle(o.key),
          count: o.count,
          title: sel.includes(o.key) ? '再点一次取消' : `只看「${o.text}」`,
        }, o.text)),
      ]);
    }

    /**
     * 需求 7：编辑表单每一栏都要说明"这一栏是什么"。
     * 所有表单统一走这个包装，避免有的栏有 label、有的没有。
     */
    function field(label, control, hint) {
      return h('label', {
        key: label,
        style: { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 },
      }, [
        h('span', {
          key: 'l',
          style: {
            fontSize: 10.5, fontWeight: 600,
            color: 'var(--dsw-alias-label-secondary)',
            letterSpacing: 0.2,
          },
        }, [label, hint ? h('span', {
          key: 'h', style: { fontWeight: 400, opacity: 0.72, marginLeft: 5 },
        }, hint) : null]),
        control,
      ]);
    }

    /**
     * 让 Agent 给指定 JD 打标的提示词。
     *
     * v1.5：标签由大模型分析，工作台（Host 半区）不自己调模型，
     * 所以这里复用「问 AI」的注入通道，把打标请求交给会话里的 Agent。
     * 词表复用约束也写在提示里，避免 Agent 每次都造新词导致同义词分裂。
     */
    function buildTaggingPrompt(jobs, taxonomy) {
      const list = jobs.map((j) => `- ${j.id} :: ${j.company} · ${j.title}`).join('\n');
      const existing = (taxonomy && taxonomy.terms || []).slice(0, 60)
        .map((t) => t.label + ((t.aliases || []).length ? `（也叫 ${t.aliases.join('、')}）` : ''))
        .join('、');
      return `请给下面 ${jobs.length} 条 JD 打技术/方向标签（career_write 的 tag_job 动作）。\n\n`
        + `【词表约束】先读 career_read 的 taxonomy 动作拿到已有词表，`
        + `**优先复用已有词**（label 或 aliases 命中即算复用，大小写/空格/全角不敏感）；`
        + `只有词表确实描述不了这条 JD 时才加新词。这条约束是为了抑制同义词分裂。\n`
        + (existing ? `\n当前已有词（部分）：${existing}\n` : '')
        + `\n【其它要求】\n`
        + `- 每条至少 1 个、最多 5 个，按重要程度排序；只标真正构成该岗位方向的东西，`
        + `行文里顺带提一次的不要算。\n`
        + `- 词的语言跟系统界面一致（中文界面用中文词）；`
        + `英文专有名词（RAG、Kubernetes 等）保持原样。\n`
        + `- 要泛化：非技术岗（产品/运营/设计/金融等）同样按该行业的方向词来标。\n`
        + `\n【待打标 JD】\n${list}\n`;
    }

    /**
     * 这个状态能否「复活」重新跟进（被拒/撤回之后）。清单由 Host 下发，兜底写死在下面。 */
    function isRevivable(status) {
      const list = META_CACHE && META_CACHE.revivable;
      if (Array.isArray(list)) return list.includes(status);
      return status === 'rejected' || status === 'withdrawn';
    }

    /**
     * 需求 11：当前展示中的 JD 池筛选。
     * `pending` 用于跨 tab 传递 —— 点气泡时 JD 页可能还没挂载，
     * 所以先把标签存下来，JD 页挂载时自己取走。
     */
    const JOB_FILTER_BUS = { fn: null, pending: null };

    /**
     * 需求 11：跳到 JD 池并按技术标签筛选。
     * 图谱页 / 技能页的彩色气泡都走这里。
     */
    function gotoJobsWithTag(tagId, jumpToTab) {
      JOB_FILTER_BUS.pending = tagId;
      if (JOB_FILTER_BUS.fn) { JOB_FILTER_BUS.fn(tagId); JOB_FILTER_BUS.pending = null; }
      if (typeof jumpToTab === 'function') jumpToTab('jobs');
    }

    // ───────────────────────── Tab: 画像 ─────────────────────────

    function ProfileTab({ onDirty, toast, confirm }) {
      const { loading, error, data, reload } = useRpc('getProfile', {}, []);
      const { data: m } = useRpc('getMeta', {}, []);
      const dims = (m && m.dimensions) || [];
      const [adding, setAdding] = useState(null);
      const [draft, setDraft] = useState({ label: '', value: '', evidence: '' });
      const [objective, setObjective] = useState('');
      const [editingId, setEditingId] = useState(null);
      const [editDraft, setEditDraft] = useState({});

      useEffect(() => { if (data) setObjective(data.objective || ''); }, [data]);

      if (loading || !dims.length) return h(StateBox, { loading: true, onRetry: reload });
      if (error) return h(StateBox, { error, onRetry: reload });
      if (!data) return h(StateBox, { loading: true, onRetry: reload });

      const tags = data.tags || [];
      const pending = tags.filter((t) => !t.confirmed);

      async function doAdd(dimKey) {
        if (!draft.label.trim()) { toast('请填写标签名', 'error'); return; }
        try {
          await call('addProfileTag', {
            tag: {
              dimension: dimKey, label: draft.label.trim(), value: draft.value,
              evidence: draft.evidence, source: 'user_explicit', confidence: 'high',
            },
          });
          setDraft({ label: '', value: '', evidence: '' });
          setAdding(null);
          reload(); onDirty && onDirty();
          toast('已添加', 'success');
        } catch (e) { toast('添加失败：' + ((e && e.message) || e), 'error'); }
      }

      async function doDelete(id, label) {
        const ok = await confirm({
          title: '删除画像标签',
          message: `确定删除「${label}」吗？此操作会记入审计日志。`,
          confirmText: '删除', danger: true,
        });
        if (!ok) return;
        try { await call('deleteProfileTag', { id }); reload(); onDirty && onDirty(); toast('已删除', 'success'); }
        catch (e) { toast('删除失败：' + ((e && e.message) || e), 'error'); }
      }

      async function doSaveEdit(id) {
        try {
          await call('updateProfileTag', { id, patch: editDraft, confirmed: true });
          setEditingId(null); setEditDraft({}); reload(); onDirty && onDirty(); toast('已保存', 'success');
        } catch (e) { toast('保存失败：' + ((e && e.message) || e), 'error'); }
      }

      async function doConfirm(id) {
        try { await call('confirmTag', { id }); reload(); onDirty && onDirty(); toast('已确认', 'success'); }
        catch (e) { toast('确认失败：' + ((e && e.message) || e), 'error'); }
      }

      async function saveObjective() {
        try { await call('setObjective', { text: objective }); reload(); onDirty && onDirty(); toast('已保存', 'success'); }
        catch (e) { toast('保存失败：' + ((e && e.message) || e), 'error'); }
      }

      // ── 需求 12：画像页视觉升级 ──
      // 之前整页只有文字，太素。这里做三件事：
      //   1) 顶部一排概览统计（已确认 / 待确认 / 维度覆盖）
      //   2) 每个维度一个专属色相，卡片左侧有色条，一眼区分板块
      //   3) 维度完整度进度条，直观看出哪块还空着
      const DIM_HUES = [212, 158, 275, 32, 340, 190, 96, 0];
      const hueOf = (key) => DIM_HUES[Math.max(0, dims.findIndex((d) => d.key === key)) % DIM_HUES.length];
      const confirmedTags = tags.filter((t) => t.confirmed);
      const filledDims = dims.filter((d) => tags.some((t) => t.dimension === d.key)).length;
      const coverage = dims.length ? Math.round(filledDims / dims.length * 100) : 0;

      /** 小统计块（需求 12） */
      function statBox(label, value, tone, hint) {
        const fg = tone || 'var(--dsw-alias-brand-primary)';
        return h('div', {
          key: label,
          title: hint,
          style: {
            flex: 1, minWidth: 0,
            border: '1px solid var(--dsw-alias-border-l1)',
            borderTop: `3px solid ${fg}`,
            borderRadius: T.radius,
            background: 'var(--dsw-alias-bg-layer-1)',
            padding: '9px 10px',
          },
        }, [
          h('div', { key: 'v', style: { fontSize: 21, fontWeight: 700, color: fg, lineHeight: 1.1 } }, String(value)),
          h('div', { key: 'l', style: { ...P.muted, marginTop: 3, fontSize: 10.5 } }, label),
        ]);
      }

      return h('div', null, [
        // 需求 12：概览统计 + 维度覆盖条
        h('div', { key: 'stats', style: { display: 'flex', gap: 8, marginBottom: 12 } }, [
          statBox('已确认标签', confirmedTags.length, 'var(--dsw-alias-state-success-primary)', '已进入正式结论的标签数'),
          statBox('待确认', pending.length,
            pending.length ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)',
            '推断出来但还没经你确认'),
          statBox('维度覆盖', `${filledDims}/${dims.length}`,
            coverage >= 70 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-brand-primary)',
            `画像完整度 ${coverage}%`),
        ]),
        h('div', { key: 'cov', style: { marginBottom: 14 } }, [
          h('div', {
            key: 'bar',
            style: {
              display: 'flex', height: 6, borderRadius: 999,
              overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-2)',
            },
          }, dims.map((d) => {
            const n = tags.filter((t) => t.dimension === d.key).length;
            return h('div', {
              key: d.key, title: `${d.label} (${n})`,
              style: {
                flex: 1,
                background: n ? tagColor(hueOf(d.key)) : 'transparent',
                opacity: n ? 1 : 0.18,
                borderRight: '1px solid var(--dsw-alias-bg-base)',
              },
            });
          })),
          h('div', { key: 'lbl', style: { ...P.muted, marginTop: 5, fontSize: 10.5 } },
            `画像完整度 ${coverage}%${coverage < 100 ? ` · 还有 ${dims.length - filledDims} 个维度是空的` : ' · 全部维度都有内容了'}`),
        ]),

        // 需求 7：目标输入加说明
        h(Section, { key: 'obj', title: '职业目标' }, [
          h('div', { key: 'r', style: { ...P.row, alignItems: 'flex-end' } }, [
            field('一句话说清你要找什么工作',
              h(Input, { key: 'i', value: objective, onChange: setObjective, placeholder: '例如：2027 届后端开发，目标杭州，偏好 AI 基础设施' }),
              '（Agent 会据此调整建议方向）'),
            h(Btn, { key: 'b', onClick: saveObjective, kind: 'primary' }, '保存'),
          ]),
        ]),

        pending.length ? h(Section, {
          key: 'pend',
          title: '待确认标签',
          count: pending.length,
          right: [h(Tag, { key: 'w', tone: 'warn' }, '不参与正式结论')],
        }, [
          h('div', { key: 'tip', style: { ...P.muted, marginBottom: 8, lineHeight: 1.6 } },
            '这些是从简历或聊天里推断出来的，确认之后才会进入正式结论。'),
          ...pending.map((t) => h(Card, { key: t.id, highlight: true }, [
          h('div', { key: 'a', style: { display: 'flex', justifyContent: 'space-between', gap: 8 } }, [
            h('div', { key: 'l', style: { minWidth: 0 } }, [
              h('div', { key: '1', style: { fontSize: T.font, fontWeight: 600 } }, `${t.label}${t.value ? `：${t.value}` : ''}`),
              h('div', { key: '2', style: { ...P.muted, marginTop: 3 } },
                `${dimLabel(dims, t.dimension)} · 来源 ${sourceLabel(t.source)}`),
              t.evidence ? h('div', { key: '3', style: { ...P.muted, marginTop: 3 } }, `依据：${t.evidence}`) : null,
            ]),
            h('div', { key: 'act', style: { ...P.row, flexShrink: 0 } }, [
              h(Btn, { key: 'ok', onClick: () => doConfirm(t.id), kind: 'primary', size: 'sm' }, '确认'),
              h(Btn, { key: 'del', onClick: () => doDelete(t.id, t.label), kind: 'danger', size: 'sm' }, '删除'),
            ]),
          ]),
        ])),
        ]) : null,

        ...dims.map((dim) => {
          const list = tags.filter((t) => t.dimension === dim.key);
          // 需求 12：这个维度的专属色相
          const hue = hueOf(dim.key);
          return h(Section, {
            key: dim.key,
            title: dim.label,
            count: list.length,
            right: [h(Btn, {
              key: 'add',
              onClick: () => { setAdding(adding === dim.key ? null : dim.key); setDraft({ label: '', value: '', evidence: '' }); },
            }, adding === dim.key ? '取消' : '+ 添加')],
          }, [
            adding === dim.key ? h(Card, { key: 'form', style: { background: 'var(--dsw-alias-bg-layer-2)' } }, [
              // 需求 7：每一栏都说明是什么
              h('div', { key: 'f1', style: { ...P.row, marginBottom: 6, alignItems: 'flex-end' } }, [
                field('标签', h(Input, { key: 'a', value: draft.label, onChange: (v) => setDraft({ ...draft, label: v }), placeholder: '例如：Python' })),
                field('程度', h(Input, { key: 'b', value: draft.value, onChange: (v) => setDraft({ ...draft, value: v }), placeholder: '例如：熟练' })),
              ]),
              h('div', { key: 'f2', style: { marginBottom: 6 } },
                field('依据', h(Input, { value: draft.evidence, onChange: (v) => setDraft({ ...draft, evidence: v }), placeholder: '例如：两个课程项目 + 一段实习' }), '（强烈建议填，Agent 给建议时会引用）')),
              h('div', { key: 'f3' }, h(Btn, { onClick: () => doAdd(dim.key), kind: 'primary' }, '保存标签')),
            ]) : null,

            list.length ? list.map((t) => {
              const isEdit = editingId === t.id;
              // 需求 12：卡片左侧维度色条，一眼区分板块
              return h(Card, {
                key: t.id, dim: !t.confirmed,
                style: { borderLeft: `3px solid ${tagColor(hue, t.confirmed ? 1 : 0.4)}` },
              }, isEdit ? [
                h('div', { key: 'e1', style: { ...P.row, marginBottom: 6 } }, [
                  h(Input, { key: 'a', value: editDraft.label ?? t.label, onChange: (v) => setEditDraft({ ...editDraft, label: v }) }),
                  h(Input, { key: 'b', value: editDraft.value ?? t.value, onChange: (v) => setEditDraft({ ...editDraft, value: v }) }),
                ]),
                h('div', { key: 'e2', style: { marginBottom: 6 } },
                  h(Input, { value: editDraft.evidence ?? t.evidence, onChange: (v) => setEditDraft({ ...editDraft, evidence: v }), placeholder: '依据' })),
                h('div', { key: 'e3', style: P.row }, [
                  h(Btn, { key: 's', onClick: () => doSaveEdit(t.id), kind: 'primary' }, '保存'),
                  h(Btn, { key: 'c', onClick: () => { setEditingId(null); setEditDraft({}); } }, '取消'),
                ]),
              ] : [
                h('div', { key: 'v', style: { display: 'flex', justifyContent: 'space-between', gap: 8 } }, [
                  h('div', { key: 'l', style: { minWidth: 0 } }, [
                    h('div', { key: '1', style: { fontSize: T.font, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } }, [
                      h('span', { key: 'n', style: { fontWeight: 600 } }, t.label),
                      t.value ? h('span', {
                        key: 'v2',
                        style: {
                          color: tagColor(hue), fontSize: 11,
                          background: tagColor(hue, 0.11),
                          borderRadius: 4, padding: '1px 6px',
                        },
                      }, t.value) : null,
                      h(Tag, { key: 's', tone: sourceTone(t.source), title: sourceHint(t.source) }, sourceLabel(t.source)),
                      !t.confirmed ? h(Tag, { key: 'p', tone: 'warn' }, '待确认') : null,
                    ]),
                    t.evidence ? h('div', { key: '2', style: { ...P.muted, marginTop: 3 } }, `依据：${t.evidence}`) : null,
                  ]),
                  h('div', { key: 'act', style: { ...P.row, flexShrink: 0 } }, [
                    h(Btn, { key: 'e', onClick: () => { setEditingId(t.id); setEditDraft({}); }, size: 'sm' }, '编辑'),
                    h(Btn, { key: 'd', onClick: () => doDelete(t.id, t.label), kind: 'danger', size: 'sm' }, '删除'),
                  ]),
                ]),
              ]);
            }) : h('div', {
              key: 'none',
              style: {
                ...P.muted, padding: '10px 12px', fontSize: 11,
                border: `1px dashed ${tagColor(hue, 0.3)}`,
                borderRadius: T.radius,
                background: tagColor(hue, 0.05),
              },
            }, `「${dim.label}」还没有记录 —— 点右上角「+ 添加」，或者直接在对话里告诉 Agent。`),
          ]);
        }),
      ]);
    }
    // ───────────────────────── Tab: 投递 ─────────────────────────

    function ApplicationsTab({ onDirty, toast, confirm, jumpToTab }) {
      const { loading, error, data, reload } = useRpc('getApplications', {}, []);
      const [showAdd, setShowAdd] = useState(false);
      const [form, setForm] = useState({ company: '', title: '', status: 'wishlist', note: '' });
      const [expanded, setExpanded] = useState(null);
      // 需求 4：按状态/公司/城市筛选 + 关键词搜索
      const [statusFilter, setStatusFilter] = useState('all');
      // 公司 / 城市改成**多选数组**（新一轮需求 4：点标签筛选，可多选，再点取消）
      const [companyFilter, setCompanyFilter] = useState([]);
      const [cityFilter, setCityFilter] = useState([]);
      const [q, setQ] = useState('');

      if (loading) return h(StateBox, { loading: true });
      if (error) return h(StateBox, { error, onRetry: reload });
      if (!data) return h(StateBox, { loading: true, onRetry: reload });

      const states = (data && data.states) || {};
      const items = (data && data.items) || [];
      const allOpts = Object.entries(states).map(([k, v]) => ({ value: k, label: v.label }));
      /**
       * rank 缺失时返回 **null**（表示"不知道"），不要兜底成某个数字。
       *
       * ⚠️ 这里踩过一个真实 bug：早期兜底成 `50`，于是所有状态的 rank 都等于 50，
       * `rankOf(k) > rankOf(cur)` 恒为 false → 目标列表永远为空
       * → 界面显示「流程已走完」，用户刚投递就改不了状态。
       * 正确做法是「不知道就不做这层过滤」，把判断交给数据层的 `next[]`。
       */
      const rankOf = (k) => (states[k] && typeof states[k].rank === 'number' ? states[k].rank : null);
      /** 复活：被拒/撤回之后可以重新回到已投递（数据层同样放行） */
      const isRevival = (from, to) => isRevivable(from) && to === 'applied';

      /**
       * 需求 2：下拉里**只给能走的下一步**。
       * 笔试之后不能再选「已投递」，二面之后不能再选「一面」——
       * 与其让用户点了报错，不如根本不展示这个选项。
       *
       * rank 信息不全时（如宿主未升级、状态表缺字段）**退化为不过滤**：
       * `next[]` 在数据层已经只列前向状态，交给它即可。
       * 宁可多给几个选项（用户点了会被数据层拦下并给出提示），
       * 也绝不能因为"算不出 rank"就把下拉清空。
       */
      function forwardTargets(fromStatus) {
        const nexts = (states[fromStatus] && states[fromStatus].next) || [];
        const cur = rankOf(fromStatus);
        if (cur === null || nexts.some((k) => rankOf(k) === null)) return nexts;
        return nexts.filter((k) => rankOf(k) > cur || isRevival(fromStatus, k));
      }

      async function add() {
        if (!form.company.trim() || !form.title.trim()) { toast('公司和岗位必填', 'error'); return; }
        try {
          await call('addApplication', { app: form });
          setForm({ company: '', title: '', status: 'wishlist', note: '' });
          setShowAdd(false); reload(); onDirty && onDirty(); toast('已新增投递', 'success');
        } catch (e) { toast('新增失败：' + ((e && e.message) || e), 'error'); }
      }

      async function changeStatus(item, next) {
        if (!next) return;
        try {
          await call('setApplicationStatus', { id: item.id, status: next });
          reload(); onDirty && onDirty();
          toast(`已更新为「${states[next] ? states[next].label : next}」`, 'success');
        } catch (e) {
          const msg = (e && e.message) || String(e);
          // 需求 2：倒退一律拒绝，引导用户用「撤销」而不是强改
          if (/流程只允许向前推进/.test(msg)) {
            toast(`${msg}`, 'error');
            return;
          }
          if (/非法状态流转/.test(msg)) {
            const ok = await confirm({
              title: '确认跳转状态',
              message: `${msg}\n\n是否强制改为「${states[next] ? states[next].label : next}」？`,
              confirmText: '强制修改',
            });
            if (ok) {
              try {
                await call('setApplicationStatus', { id: item.id, status: next, force: true });
                reload(); onDirty && onDirty(); toast('已强制更新', 'success');
              } catch (e2) { toast('失败：' + ((e2 && e2.message) || e2), 'error'); }
            }
          } else { toast('更新失败：' + msg, 'error'); }
        }
      }

      /** 需求 3：撤销上一次状态变更（防误触） */
      async function undo(item) {
        const ok = await confirm({
          title: '撤销上一次状态变更',
          message: `把「${item.company} · ${item.title}」退回上一次的状态？\n\n`
            + `当前：${states[item.status] ? states[item.status].label : item.status}\n`
            + '撤销本身也会记进时间线，历史不会被抹掉。',
          confirmText: '撤销',
        });
        if (!ok) return;
        try {
          const r = await call('undoApplicationStatus', { id: item.id });
          reload(); onDirty && onDirty();
          toast(`已撤销，现在的状态是「${states[r.status] ? states[r.status].label : r.status}」`, 'success');
        } catch (e) { toast('撤销失败：' + ((e && e.message) || e), 'error'); }
      }

      async function del(item) {
        const ok = await confirm({
          title: '删除投递记录',
          message: `删除「${item.company} · ${item.title}」？此操作不可撤销。`,
          confirmText: '删除', danger: true,
        });
        if (!ok) return;
        try { await call('deleteApplication', { id: item.id }); reload(); onDirty && onDirty(); toast('已删除', 'success'); }
        catch (e) { toast('删除失败：' + ((e && e.message) || e), 'error'); }
      }

      // 需求 4：筛选 + 搜索
      const companies = [...new Set(items.map((it) => it.company).filter(Boolean))].sort();
      // 城市可能没填，统一归到「未填」这一档，免得它变成不可筛的隐形数据
      // 多城市记录（「北京/上海」）计入它面向的每一个城市
      const cities = [...new Set(items.flatMap((it) => splitCities(it.city, '未填')))].sort();
      const kw = q.trim().toLowerCase();
      const shown = items.filter((it) => {
        if (statusFilter !== 'all' && it.status !== statusFilter) return false;
        if (!matchAny(companyFilter, it.company)) return false;
        if (!matchCity(cityFilter, it.city)) return false;
        if (!kw) return true;
        return `${it.company || ''} ${it.title || ''} ${it.note || ''} ${it.city || ''}`
          .toLowerCase().includes(kw);
      });
      const hasFilter = !!kw || statusFilter !== 'all'
        || (companyFilter.length > 0) || (cityFilter.length > 0);

      const groups = new Map();
      for (const it of shown) {
        if (!groups.has(it.status)) groups.set(it.status, []);
        groups.get(it.status).push(it);
      }
      // 按 rank 排序分组：进度靠前的显示在前面
      const orderedGroups = [...groups].sort((a, b) => {
        // rank 可能缺失（宿主未升级）→ 视为最大，排在最后而不是报错
        const ra = rankOf(a[0]);
        const rb = rankOf(b[0]);
        return (ra === null ? 999 : ra) - (rb === null ? 999 : rb);
      });
      const statusCounts = new Map();
      for (const it of items) statusCounts.set(it.status, (statusCounts.get(it.status) || 0) + 1);

      return h('div', null, [
        h(Section, {
          key: 'hd', title: '投递进度', count: items.length,
          right: [h(Btn, { key: 'a', onClick: () => setShowAdd(!showAdd), kind: showAdd ? 'default' : 'primary' }, showAdd ? '取消' : '+ 新增投递')],
        }, [
          showAdd ? h(Card, { key: 'f', style: { background: 'var(--dsw-alias-bg-layer-2)' } }, [
            h('div', { key: '1', style: { ...P.row, marginBottom: 6 } }, [
              field('公司', h(Input, { key: 'a', value: form.company, onChange: (v) => setForm({ ...form, company: v }), placeholder: '例如：字节跳动' })),
              field('岗位', h(Input, { key: 'b', value: form.title, onChange: (v) => setForm({ ...form, title: v }), placeholder: '例如：算法实习生' })),
            ]),
            h('div', { key: '2', style: { ...P.row, marginBottom: 6 } }, [
              field('当前状态', h(Select, { key: 'a', value: form.status, onChange: (v) => setForm({ ...form, status: v }), options: allOpts })),
              field('备注（可选）', h(Input, { key: 'b', value: form.note, onChange: (v) => setForm({ ...form, note: v }), placeholder: '例如：官网投递' })),
            ]),
            h(Btn, { key: '3', onClick: add, kind: 'primary' }, '保存'),
          ]) : null,

          // 需求 4：筛选条
          items.length ? h('div', { key: 'flt', style: { marginBottom: 10 } }, [
            h('div', { key: 'r1', style: { display: 'flex', gap: 6, marginBottom: 8 } }, [
              h(Input, {
                key: 'q', value: q, onChange: setQ,
                placeholder: '搜索公司 / 岗位 / 备注…',
                style: { flex: 1 },
              }),
            ]),
            // 需求 4（新一轮）：公司 / 城市做成**可多选**的标签，再点一次取消
            h(FilterTagRow, {
              key: 'co', label: '公司',
              all: companies.map((c) => ({
                key: c, text: c,
                count: items.filter((x) => x.company === c).length,
              })),
              selected: companyFilter,
              onToggle: (k) => setCompanyFilter((cur) => toggleIn(cur, k)),
              onClear: () => setCompanyFilter([]),
            }),
            cities.length > 1 ? h(FilterTagRow, {
              key: 'ci', label: '城市',
              all: cities.map((c) => ({
                key: c, text: c,
                count: items.filter((x) => splitCities(x.city, '未填').includes(c)).length,
              })),
              selected: cityFilter,
              onToggle: (k) => setCityFilter((cur) => toggleIn(cur, k)),
              onClear: () => setCityFilter([]),
            }) : null,
            h('div', { key: 'r2', style: { display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 } }, [
              h(Chip, {
                key: 'all', active: statusFilter === 'all',
                onClick: () => setStatusFilter('all'), count: items.length,
              }, '全部状态'),
              ...allOpts.filter((o) => statusCounts.get(o.value)).map((o) => h(Chip, {
                key: o.value, active: statusFilter === o.value,
                onClick: () => setStatusFilter(statusFilter === o.value ? 'all' : o.value),
                count: statusCounts.get(o.value),
              }, o.label)),
            ]),
            hasFilter
              ? h('div', { key: 'r3', style: { ...P.muted, marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' } }, [
                h('span', { key: 't' }, `筛选出 ${shown.length} / ${items.length} 条`),
                h(Btn, {
                  key: 'c', size: 'sm',
                  onClick: () => { setStatusFilter('all'); setCompanyFilter([]); setCityFilter([]); setQ(''); },
                }, '清除全部筛选'),
              ])
              : null,
          ]) : null,
        ]),

        orderedGroups.length ? orderedGroups.map(([status, list]) => h('div', { key: status, style: { marginBottom: 12 } }, [
          h('div', { key: 'h', style: { ...P.row, marginBottom: 6 } }, [
            h(Tag, {
              key: 't',
              tone: (status === 'offer' || status === 'accepted') ? 'ok' : status === 'rejected' ? 'err' : 'default',
            }, states[status] ? states[status].label : status),
            // 需求 5：计数用 () 包裹
            h('span', { key: 'c', style: P.muted }, `(${list.length})`),
          ]),
          ...list.map((it) => {
            const isOpen = expanded === it.id;
            const targets = forwardTargets(it.status);
            const canUndo = (it.timeline || []).filter((t) => t.status !== 'undo'
              && ['applied', 'resume_screen', 'written_test', 'interview_1', 'interview_2',
                'interview_3', 'hr_interview', 'offer', 'accepted', 'rejected', 'withdrawn']
              .includes(t.status)).length > 1;
            return h(Card, { key: it.id }, [
              h('div', { key: '1', style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' } }, [
                h('div', {
                  key: 'l', style: { cursor: 'pointer', minWidth: 0, flex: 1 },
                  onClick: () => setExpanded(isOpen ? null : it.id),
                }, [
                  h('div', { key: 'a', style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } }, [
                    h('span', { key: 't', style: { fontSize: T.font, fontWeight: 600 } }, `${it.company} · ${it.title}`),
                    // 需求 1：未展开也能看到投递状态
                    h(Tag, {
                      key: 's',
                      tone: (it.status === 'offer' || it.status === 'accepted') ? 'ok'
                        : it.status === 'rejected' ? 'err'
                          : it.status === 'wishlist' ? 'default' : 'brand',
                    }, states[it.status] ? states[it.status].label : it.status),
                  ]),
                  // 需求 1：未展开也能看到最后更新时间
                  h('div', { key: 'b', style: { ...P.muted, marginTop: 3 } },
                    `最后更新 ${relTime(it.updatedAt)}${it.note ? ` · ${it.note}` : ''} · ${isOpen ? '收起时间线' : '展开时间线'}`),
                ]),
                // 需求 6：关键按钮不展开也能看见
                h('div', { key: 'r', style: { ...P.row, flexShrink: 0 } }, [
                  canUndo ? h(Btn, {
                    key: 'u', kind: 'default', size: 'sm', title: '撤销上一次状态变更',
                    onClick: () => undo(it),
                  }, '撤销') : null,
                  h(Btn, {
                    key: 'd', kind: 'danger', size: 'sm', title: '删除此投递',
                    onClick: () => del(it),
                  }, '删除'),
                ]),
              ]),
              // 需求 2：下拉只出现在卡片下方、只列可行目标
              h('div', { key: 'mv', style: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 } }, [
                targets.length ? [
                  h('span', { key: 'l', style: P.muted }, '推进到'),
                  h(Select, {
                    key: 's', value: '', onChange: (v) => v && changeStatus(it, v),
                    options: [{ value: '', label: '选择下一步…' },
                      ...targets.map((k) => ({ value: k, label: states[k] ? states[k].label : k }))],
                    style: { maxWidth: 150 },
                  }),
                ] : h(Tag, {
                  key: 'end',
                  // 无可行下一步时才走到这里：要么已结束（可复活），要么已经是终态
                  tone: isRevivable(it.status) ? 'err' : 'ok',
                }, isRevivable(it.status) ? '已结束' : '流程已走完'),
                isRevivable(it.status) ? h(Btn, {
                  key: 'rv', size: 'sm', kind: 'default',
                  onClick: () => changeStatus(it, 'applied'),
                }, '重新跟进') : null,
              ]),
              isOpen ? h('div', { key: 'tl', style: { marginTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 10 } }, [
                h('div', { key: 't', style: { fontSize: T.fontSm, fontWeight: 600, marginBottom: 6 } }, '投递时间线（只追加，不覆盖历史）'),
                ...(it.timeline || []).map((ev, i) => h('div', {
                  key: i, style: { ...P.muted, marginBottom: 4, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
                }, [
                  h('span', { key: 'd', style: { fontVariantNumeric: 'tabular-nums' } }, ev.at),
                  h('span', {
                    key: 's',
                    style: {
                      color: ev.status === 'undo' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-primary)',
                      fontWeight: ev.status === 'undo' ? 600 : 400,
                    },
                  }, ev.status === 'undo'
                    ? `撤销（${ev.from ? (states[ev.from] ? states[ev.from].label : ev.from) : '?'} → ${states[ev.to] ? states[ev.to].label : ev.to}）`
                    : (states[ev.status] ? states[ev.status].label : ev.status)),
                  ev.note && ev.status !== 'undo' ? h('span', { key: 'n' }, `（${ev.note}）`) : null,
                  ev.actor ? h(Tag, { key: 'a', tone: ev.actor === 'user' ? 'ok' : 'brand' }, ev.actor === 'user' ? '你' : 'AI') : null,
                ])),
              ]) : null,
            ]);
          }),
        ])) : h(StateBox, {
          key: 'e', empty: true, emptyIcon: '📮',
          emptyText: items.length
            ? '没有符合筛选条件的投递记录。'
            : '还没有投递记录。可以在 JD 池点「去投递」，或在上面手动新增。',
        }),
      ]);
    }

    // ───────────────────────── Tab: JD 池 ─────────────────────────

    function JobsTab({ onDirty, toast, confirm }) {
      const { loading, error, data, reload } = useRpc('getJobs', {}, []);
      const [filter, setFilter] = useState('');
      const [timeRange, setTimeRange] = useState('all');
      const [groupBy, setGroupBy] = useState('company');
      const [openId, setOpenId] = useState(null);
      const [showAdd, setShowAdd] = useState(false);
      const [form, setForm] = useState({ company: '', title: '', city: '', url: '', description: '', requirements: '', skills: '' });
      const [editingId, setEditingId] = useState(null);
      const [editDraft, setEditDraft] = useState({});
      const [checking, setChecking] = useState(false);
      // 需求 11：从「技能图谱」点彩色气泡跳过来时，按技术标签筛选 JD
      const [techFilter, setTechFilter] = useState(null);
      const [lifecycle, setLifecycle] = useState('all');
      // 需求 4（新一轮）：公司 / 城市可多选标签筛选
      const [companySel, setCompanySel] = useState([]);
      const [citySel, setCitySel] = useState([]);

      const items = (data && data.items) || [];
      const buckets = (data && data.buckets) || {};

      /**
       * 需求 11：把「点气泡 → 跳到 JD 池看相关 JD」这件事接上。
       * 图谱页调用 gotoJobsWithTag(id) 后本页才挂载，所以先取 pending。
       */
      useEffect(() => {
        JOB_FILTER_BUS.fn = (tagId) => { setTechFilter(tagId || null); setLifecycle('all'); };
        if (JOB_FILTER_BUS.pending) {
          setTechFilter(JOB_FILTER_BUS.pending);
          setLifecycle('all');
          JOB_FILTER_BUS.pending = null;
        }
        return () => { JOB_FILTER_BUS.fn = null; };
      }, []);

      // ★ 所有 hooks 必须在 early return 之前
      const filtered = useMemo(() => {
        let list = items;
        // 需求 4（新一轮）：公司 / 城市多选筛选
        if (companySel.length) list = list.filter((j) => matchAny(companySel, j.company, '未知公司'));
        if (citySel.length) list = list.filter((j) => matchCity(citySel, j.city, '未知城市'));
        // 需求 11：技术标签筛选
        if (techFilter) {
          list = list.filter((j) => (j.businessSkills || []).includes(techFilter));
        }
        if (lifecycle !== 'all') {
          list = list.filter((j) => {
            const st = j.status || 'active';
            return lifecycle === 'active' ? st === 'active' : st === lifecycle;
          });
        }
        if (filter.trim()) {
          const q = filter.trim().toLowerCase();
          list = list.filter((j) => ['company', 'title', 'city', 'description', 'requirements']
            .some((f) => String(j[f] || '').toLowerCase().includes(q))
            || (j.skills || []).some((s) => String(s).toLowerCase().includes(q)));
        }
        return list.filter((j) => inTimeRange(j, timeRange));
      }, [items, filter, timeRange, techFilter, lifecycle, companySel, citySel]);

      const grouped = useMemo(() => {
        const m = new Map();
        for (const j of filtered) {
          const k = groupBy === 'company' ? (j.company || '未知公司')
            : groupBy === 'city' ? (j.city || '未知城市') : '全部';
          if (!m.has(k)) m.set(k, []);
          m.get(k).push(j);
        }
        return [...m].sort((a, b) => b[1].length - a[1].length);
      }, [filtered, groupBy]);

      /** 需求 4（新一轮）：公司 / 城市的可点选清单（含计数，按数量降序） */
      const companyFacet = useMemo(() => {
        const m = new Map();
        for (const j of items) {
          const k = j.company || '未知公司';
          m.set(k, (m.get(k) || 0) + 1);
        }
        return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, text: k, count: n }));
      }, [items]);
      const cityFacet = useMemo(() => {
        const m = new Map();
        for (const j of items) {
          // 多城市岗位计入它面向的每一个城市（「北京/上海」同时给北京和上海 +1）
          for (const c of new Set(splitCities(j.city, '未知城市'))) {
            m.set(c, (m.get(c) || 0) + 1);
          }
        }
        return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, text: k, count: n }));
      }, [items]);

      const timeCounts = useMemo(() => {
        const c = {};
        for (const f of TIME_FILTERS) c[f.key] = items.filter((j) => inTimeRange(j, f.key)).length;
        return c;
      }, [items]);

      /** 需求 2：各状态计数（在招 / 已过期 / 待删除） */
      const statusCounts = useMemo(() => ({
        active: items.filter((j) => j.status === 'active' || !j.status).length,
        expired: items.filter((j) => j.status === 'expired').length,
        pending_delete: items.filter((j) => j.status === 'pending_delete').length,
      }), [items]);

      if (loading) return h(StateBox, { loading: true });
      if (error) return h(StateBox, { error, onRetry: reload });
      if (!data) return h(StateBox, { loading: true, onRetry: reload });

      async function add() {
        if (!form.company.trim() || !form.title.trim()) { toast('公司和岗位必填', 'error'); return; }
        try {
          const r = await call('upsertJob', {
            job: {
              ...form,
              skills: form.skills.split(/[,，、;；|]/).map((s) => s.trim()).filter(Boolean),
              source: 'manual',
            },
          });
          toast(r.isNew ? '已新增' : '已存在，已更新', 'success');
          setForm({ company: '', title: '', city: '', url: '', description: '', requirements: '', skills: '' });
          reload(); onDirty && onDirty();
        } catch (e) { toast('保存失败：' + ((e && e.message) || e), 'error'); }
      }

      async function saveEdit(id) {
        try {
          const patch = { ...editDraft };
          if (typeof patch.skills === 'string') {
            patch.skills = patch.skills.split(/[,，、;；|]/).map((s) => s.trim()).filter(Boolean);
          }
          await call('updateJob', { id, patch });
          setEditingId(null); setEditDraft({});
          reload(); onDirty && onDirty();
          toast('已保存（业务能力标签已自动重算）', 'success');
        } catch (e) { toast('保存失败：' + ((e && e.message) || e), 'error'); }
      }

      async function del(j) {
        const ok = await confirm({
          title: '删除 JD',
          message: `删除「${j.company} · ${j.title}」？`,
          confirmText: '删除', danger: true,
        });
        if (!ok) return;
        try { await call('deleteJob', { id: j.id }); reload(); onDirty && onDirty(); toast('已删除', 'success'); }
        catch (e) { toast('删除失败：' + ((e && e.message) || e), 'error'); }
      }

      /**
       * 需求 1：去投递。
       * 用户确认后**直接进入「已投递」流程**，不是先建个 wishlist 再让用户改。
       * 原始需求："如果点的 JD 池中的去投递并且确认的话就直接进入已投递的流程"。
       */
      async function goApply(j) {
        if (j.url) window.open(j.url, '_blank', 'noopener,noreferrer');
        const ok = await confirm({
          title: j.url ? '已打开岗位页面，要记录投递吗？' : '这个 JD 没有记录链接',
          message: j.url
            ? `已在浏览器新标签页打开：\n${j.url}\n\n确认后「${j.company} · ${j.title}」会直接进入**已投递**，\n可以在「投递」页记录笔试、面试、Offer 等后续进度。`
            : `「${j.company} · ${j.title}」没有链接。\n\n确认后它会直接进入**已投递**状态。`,
          confirmText: '已投递，记录一下',
          cancelText: '还没投',
        });
        if (!ok) return;
        try {
          // status 显式给 applied —— 这就是"直接进入已投递的流程"
          await call('addApplication', {
            app: { jobId: j.id, status: 'applied', note: '从 JD 池「去投递」' },
          });
          onDirty && onDirty();
          toast('已记为「已投递」，可到「投递」页跟进', 'success');
        } catch (e) {
          const msg = (e && e.message) || String(e);
          if (/已存在/.test(msg)) {
            const again = await confirm({
              title: '这个岗位已经记录过了',
              message: `${msg}\n\n要把它标记为「已投递」吗？`,
              confirmText: '标记已投递',
            });
            if (again) {
              try {
                const apps = await call('getApplications', {});
                const hit = (apps.items || []).find((a) => a.jobId === j.id);
                if (hit) {
                  await call('setApplicationStatus', { id: hit.id, status: 'applied', note: '从 JD 池再次投递' });
                  onDirty && onDirty();
                  toast('已更新为「已投递」', 'success');
                }
              } catch (e2) { toast('更新失败：' + ((e2 && e2.message) || e2), 'error'); }
            }
          } else toast('加入投递失败：' + msg, 'error');
        }
      }

      /** 需求 10：一键把这个 JD 注入聊天输入框，直接问 AI */
      async function askAI(j) {
        const text = buildAskPrompt(j, META_CACHE);
        // v1.5.5：注入前先确认放哪儿（当前会话 / 新建会话），
        // 避免把提示词塞进一个已经有对话的会话里、或覆盖用户正在写的草稿。
        if (await confirmThenFill(text, confirm)) {
          toast('已把这条 JD 填进粘贴到剪切板，请在职业规划预设中，按Ctrl+V复制到聊天框中，发送给 Agent', 'success');
          return;
        }
        const copied = await copyToClipboard(text);
        toast(copied
          ? '没找到聊天输入框，已复制到剪贴板，粘贴到对话里即可'
          : '没找到聊天输入框，请手动把 JD 贴进对话', copied ? 'info' : 'error');
      }

      /**
       * v1.5：让 Agent 给 JD 打技术标签。
       * 工作台自己不调模型（Host 半区没有会话上下文），
       * 所以复用「注入聊天框」的通道，把打标任务交给会话里的 Agent。
       */
      async function askTag(jobs) {
        const list = (Array.isArray(jobs) ? jobs : [jobs]).filter(Boolean);
        if (!list.length) { toast('没有需要打标的 JD', 'info'); return; }
        let taxonomy = null;
        try { taxonomy = await call('getTaxonomy', {}); } catch { /* 拿不到词表就先不带上，Agent 会自己读 */ }
        const text = buildTaggingPrompt(list, taxonomy);
        if (await confirmThenFill(text, confirm)) {
          toast(`已把 ${list.length} 条 JD 的打标任务粘贴剪切板，请在职业规划预设中，按Ctrl+V复制到聊天框中，发送给 Agent`, 'success');
          return;
        }
        const copied = await copyToClipboard(text);
        toast(copied ? '没找到聊天框，打标任务已复制到剪贴板' : '自动打标入口不可用', copied ? 'info' : 'error');
      }

      /**
       * 待 AI 打标的 JD（含"内容已改、标签作废"的）。
       * ⚠️ 这里刻意**不用 useMemo**：本函数位于 early return 之后，
       * 加任何 hook 都会触发 React #310（hooks 数量在 loading 态与数据态之间不一致）。
       * 一次 filter 开销可忽略。
       */
      const untagged = items.filter((j) => !(Array.isArray(j.businessSkills) && j.businessSkills.length));

      /** 需求 9：恢复被误判失效的 JD */
      async function restore(j) {
        try {
          await call('restoreJob', { id: j.id });
          reload(); onDirty && onDirty();
          toast('已恢复为「在招」', 'success');
        } catch (e) { toast('恢复失败：' + ((e && e.message) || e), 'error'); }
      }

      /** 需求 9：立刻清理待删除的 JD（不必等满一天） */
      async function purgeNow() {
        const ok = await confirm({
          title: '立即清理待删除的 JD',
          message: '把已经确认链接失效、且过了宽限期的 JD 从池子里删掉。\n'
            + '（正常情况打开工作台时会自动清理，这里只是手动触发）',
          confirmText: '清理', danger: true,
        });
        if (!ok) return;
        try {
          const r = await call('purgePendingDelete', { graceDays: 1 });
          reload(); onDirty && onDirty();
          toast(r.purged
            ? `已清理 ${r.purged} 条：${(r.titles || []).join('、')}`
            : '没有可清理的 JD（要么没过宽限期，要么没有待删除项）', 'info');
        } catch (e) { toast('清理失败：' + ((e && e.message) || e), 'error'); }
      }

      /**
       * 需求 9：检测**已过期** JD 的链接还能不能访问。
       * 能访问 → 复活；不能访问 → 标记待删除，一天后自动删掉。
       */
      async function checkStaleLinks() {
        if (!timeCounts.expired) { toast('没有已过期的 JD 需要检测', 'info'); return; }
        setChecking(true);
        toast(`开始检测 ${Math.min(timeCounts.expired, 20)} 条已过期 JD 的链接…`, 'info');
        try {
          const r = await call('checkLinks', { limit: 20 });
          reload(); onDirty && onDirty();
          const parts = [`检测 ${r.checked} 条`];
          if (r.revived) parts.push(`${r.revived} 条还能访问，已恢复在招`);
          if (r.pendingDelete) parts.push(`${r.pendingDelete} 条确认失效，已标记待删除`);
          if (r.unknown) parts.push(`${r.unknown} 条无法确认（反爬），保持不动`);
          if (r.remaining) parts.push(`还剩 ${r.remaining} 条`);
          toast(parts.join('；'), r.pendingDelete ? 'info' : 'success');
        } catch (e) { toast('检测失败：' + ((e && e.message) || e), 'error'); }
        finally { setChecking(false); }
      }

      return h('div', null, [
        h(Section, {
          key: 'hd', title: 'JD 信息池', count: items.length,
          right: [
            h(Btn, {
              key: 'chk', onClick: checkStaleLinks, disabled: checking || !statusCounts.expired,
              title: statusCounts.expired
                ? '检测已过期 JD 的链接：还能访问就恢复在招，访问不到就标记待删除'
                : '目前没有已过期的 JD',
            }, checking ? '检测中…' : `检测失效 (${statusCounts.expired})`),
            statusCounts.pending_delete ? h(Btn, {
              key: 'pg', onClick: purgeNow, kind: 'danger',
              title: '立刻清理待删除的 JD（正常会自动清理）',
            }, `清理 (${statusCounts.pending_delete})`) : null,
            h(Btn, { key: 'a', onClick: () => setShowAdd(!showAdd), kind: showAdd ? 'default' : 'primary' }, showAdd ? '取消' : '+ 手动录入'),
            // v1.5：批量补打标入口（标签由 Agent 分析，工作台只负责把任务递过去）
            untagged.length ? h(Btn, {
              key: 'tagall', size: 'sm',
              title: `有 ${untagged.length} 条 JD 还没有技术标签，一次性交给 Agent 分析`,
              onClick: () => askTag(untagged),
            }, `让 AI 补标签 (${untagged.length})`) : null,
          ],
        }, [
          // 需求 7：录入表单每一栏都标明是什么
          showAdd ? h(Card, { key: 'f', style: { background: 'var(--dsw-alias-bg-layer-2)' } }, [
            h('div', { key: '1', style: { ...P.row, marginBottom: 6, alignItems: 'flex-end' } }, [
              field('公司', h(Input, { key: 'a', value: form.company, onChange: (v) => setForm({ ...form, company: v }), placeholder: '例如：字节跳动' })),
              field('岗位名称', h(Input, { key: 'b', value: form.title, onChange: (v) => setForm({ ...form, title: v }), placeholder: '例如：算法实习生' })),
            ]),
            h('div', { key: '2', style: { ...P.row, marginBottom: 6, alignItems: 'flex-end' } }, [
              field('城市', h(Input, { key: 'a', value: form.city, onChange: (v) => setForm({ ...form, city: v }), placeholder: '例如：杭州' })),
              field('岗位链接', h(Input, { key: 'b', value: form.url, onChange: (v) => setForm({ ...form, url: v }), placeholder: 'https://…' })),
            ]),
            h('div', { key: '3', style: { marginBottom: 6 } },
              field('技能关键词', h(Input, { value: form.skills, onChange: (v) => setForm({ ...form, skills: v }), placeholder: '逗号分隔，例如：语音大模型, 度量学习' }), '＝这条 JD 的技术标签（1~5 个，气泡与图谱都读它）')),
            h('div', { key: '4', style: { marginBottom: 6 } },
              field('招聘要求', h(TextArea, { value: form.requirements, onChange: (v) => setForm({ ...form, requirements: v }), placeholder: '把 JD 里的「任职要求」整段粘进来', rows: 3 }), '（关键词留空时，让 AI 读这段来补标签）')),
            h('div', { key: '5', style: { marginBottom: 8 } },
              field('岗位描述', h(TextArea, { value: form.description, onChange: (v) => setForm({ ...form, description: v }), placeholder: '把 JD 里的「岗位职责」整段粘进来', rows: 3 }))),
            h(Btn, { key: '6', onClick: add, kind: 'primary' }, '保存 JD'),
          ]) : null,

          h('div', { key: 'bar', style: { ...P.row, marginBottom: 8 } }, [
            h(Input, { key: 'f', value: filter, onChange: setFilter, placeholder: '搜索公司 / 岗位 / 技能…' }),
            h(Select, {
              key: 'g', value: groupBy, onChange: setGroupBy,
              options: [{ value: 'company', label: '按公司' }, { value: 'city', label: '按城市' }, { value: 'none', label: '不分组' }],
              style: { maxWidth: 96 },
            }),
          ]),

          // 需求 4（新一轮）：点公司 / 城市标签筛选，可多选，再点一次取消
          h(FilterTagRow, {
            key: 'fco', label: '公司',
            all: companyFacet,
            selected: companySel,
            onToggle: (k) => setCompanySel((cur) => toggleIn(cur, k)),
            onClear: () => setCompanySel([]),
          }),
          cityFacet.length > 1 ? h(FilterTagRow, {
            key: 'fci', label: '城市',
            all: cityFacet,
            selected: citySel,
            onToggle: (k) => setCitySel((cur) => toggleIn(cur, k)),
            onClear: () => setCitySel([]),
          }) : null,

          // 需求 2：时间范围筛选（常驻可见）；需求 5：计数用 ()
          h('div', { key: 'tf', style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 } },
            TIME_FILTERS.map((tf) => h(Chip, {
              key: tf.key,
              active: timeRange === tf.key,
              onClick: () => setTimeRange(timeRange === tf.key ? 'all' : tf.key),
              count: timeCounts[tf.key],
            }, tf.label))),

          // 需求 9：生命周期状态筛选（在招 / 已过期 / 待删除）
          h('div', { key: 'lf', style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 9 } }, [
            h(Chip, { key: 'all', active: lifecycle === 'all', onClick: () => setLifecycle('all'), count: items.length }, '全部状态'),
            h(Chip, { key: 'a', active: lifecycle === 'active', onClick: () => setLifecycle('active'), count: statusCounts.active }, '在招'),
            statusCounts.expired ? h(Chip, {
              key: 'x', active: lifecycle === 'expired', onClick: () => setLifecycle('expired'),
              count: statusCounts.expired, hue: 20,
            }, '已过期') : null,
            statusCounts.pending_delete ? h(Chip, {
              key: 'p', active: lifecycle === 'pending_delete', onClick: () => setLifecycle('pending_delete'),
              count: statusCounts.pending_delete, hue: 0,
            }, '待删除') : null,
          ]),

          // 需求 11：点图谱气泡跳过来的筛选提示
          techFilter ? h('div', {
            key: 'tfx',
            style: {
              ...P.row, marginBottom: 8, padding: '6px 9px', borderRadius: 8,
              background: tagStyle(bizHue(techFilter), false).background,
              border: `1px solid ${tagColor(bizHue(techFilter), 0.32)}`,
            },
          }, [
            h('span', { key: 'l', style: { color: tagColor(bizHue(techFilter)), fontWeight: 600 } },
              `只看「${bizLabel(techFilter)}」方向的 JD (${filtered.length})`),
            h('span', { key: 'sp', style: { flex: 1 } }),
            h(Btn, { key: 'c', size: 'sm', onClick: () => setTechFilter(null) }, '清除'),
          ]) : null,

          // 需求 11：彩色技术标签词频 —— 点一下就能筛出相关 JD
          buckets.tagFreq && buckets.tagFreq.length ? h('div', {
            key: 'bf',
            style: { marginBottom: 9, display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' },
          }, [
            h('span', { key: 'l', style: { ...P.muted, flexShrink: 0 } }, '热门方向：'),
            ...buckets.tagFreq.slice(0, 10).map((b) => h(TechBubble, {
              key: b.id, id: b.id, label: b.label, hue: b.hue, count: b.count,
              active: techFilter === b.id,
              onClick: () => setTechFilter(techFilter === b.id ? null : b.id),
            })),
          ]) : null,

          // 需求 4（新一轮）：公司/城市已经在上面做成可点选的 FilterTagRow，
          // 这里原来那份只读的公司 Tag 列表就重复了，删掉以免两处信息打架。

          // 已选筛选条件的总览 + 一键清除
          (companySel.length || citySel.length || techFilter || filter.trim() || timeRange !== 'all' || lifecycle !== 'all')
            ? h('div', {
              key: 'sum',
              style: { ...P.muted, marginTop: 8, marginBottom: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
            }, [
              h('span', { key: 't' }, `筛选出 ${filtered.length} / ${items.length} 条`),
              h(Btn, {
                key: 'c', size: 'sm',
                onClick: () => {
                  setCompanySel([]); setCitySel([]); setTechFilter(null);
                  setFilter(''); setTimeRange('all'); setLifecycle('all');
                },
              }, '清除全部筛选'),
            ])
            : null,
        ]),

        filtered.length ? grouped.map(([group, list]) => h('div', { key: group, style: { marginBottom: 14 } }, [
          // 需求 5：分组计数用 ()
          h('div', { key: 'h', style: { ...P.muted, fontWeight: 600, marginBottom: 6 } }, `${group} (${list.length})`),
          ...list.map((j) => {
            const isOpen = openId === j.id;
            const isEditing = editingId === j.id;
            const days = daysSince(j.updatedAt || j.collectedAt);
            const willExpire = days !== null && days > 15 && j.status !== 'expired' && j.status !== 'pending_delete';
            const expired = j.status === 'expired';
            const pendingDelete = j.status === 'pending_delete';
            const dead = expired || pendingDelete;
            return h(Card, { key: j.id, dim: dead }, isEditing ? [
              // ── 需求 4 / 需求 7：界面内编辑，每栏都有说明 ──
              h('div', { key: 'e1', style: { ...P.row, marginBottom: 6, alignItems: 'flex-end' } }, [
                field('公司', h(Input, { key: 'a', value: editDraft.company ?? j.company, onChange: (v) => setEditDraft({ ...editDraft, company: v }), placeholder: '公司' })),
                field('岗位名称', h(Input, { key: 'b', value: editDraft.title ?? j.title, onChange: (v) => setEditDraft({ ...editDraft, title: v }), placeholder: '岗位' })),
              ]),
              h('div', { key: 'e2', style: { ...P.row, marginBottom: 6, alignItems: 'flex-end' } }, [
                field('城市', h(Input, { key: 'a', value: editDraft.city ?? j.city, onChange: (v) => setEditDraft({ ...editDraft, city: v }), placeholder: '城市' })),
                field('岗位链接', h(Input, { key: 'b', value: editDraft.url ?? j.url, onChange: (v) => setEditDraft({ ...editDraft, url: v }), placeholder: 'https://…' })),
              ]),
              h('div', { key: 'e3', style: { marginBottom: 6 } },
                field('技能关键词', h(Input, {
                  // ★ 「技能关键词」就是这条 JD 的技术标签（v1.5.1 语义统一）。
                  // 预填取标签名，让编辑栏显示的和内容完全一致 ——
                  // 否则用户改了这个、气泡还是旧的，正是这个字段以前的问题。
                  value: editDraft.skills ?? (j.skills || []).join(', '),
                  onChange: (v) => setEditDraft({ ...editDraft, skills: v }),
                  placeholder: '逗号分隔，1~5 个',
                }), '＝这条 JD 的技术标签；改动会立刻同步到气泡与图谱（留空＝清空）')),
              h('div', { key: 'e4', style: { marginBottom: 6 } },
                field('招聘要求', h(TextArea, {
                  value: editDraft.requirements ?? j.requirements,
                  onChange: (v) => setEditDraft({ ...editDraft, requirements: v }),
                  placeholder: '任职要求原文', rows: 3,
                }), '（改动后会重算技术标签）')),
              h('div', { key: 'e5', style: { marginBottom: 8 } },
                field('岗位描述', h(TextArea, {
                  value: editDraft.description ?? j.description,
                  onChange: (v) => setEditDraft({ ...editDraft, description: v }),
                  placeholder: '岗位职责原文', rows: 3,
                }))),
              // 需求 9：不再提供状态下拉。状态由系统按"15 天自动过期 + 链接检测"决定，
              // 用户要干预只用「恢复」，不再手工挑一个状态。
              h('div', { key: 'e6', style: { ...P.muted, marginBottom: 8 } },
                `当前状态：${pendingDelete ? '待删除' : expired ? '已过期' : '在招'}（由系统按收录时间与链接检测自动维护，不需要手动选）`),
              h('div', { key: 'e7', style: P.row }, [
                h(Btn, { key: 's', onClick: () => saveEdit(j.id), kind: 'primary' }, '保存'),
                h(Btn, { key: 'c', onClick: () => { setEditingId(null); setEditDraft({}); } }, '取消'),
                dead ? h(Btn, { key: 'r', onClick: () => restore(j) }, '恢复为在招') : null,
              ]),
            ] : [
              h('div', {
                key: '1',
                style: { display: 'flex', justifyContent: 'space-between', gap: 8, cursor: 'pointer' },
                onClick: () => setOpenId(isOpen ? null : j.id),
              }, [
                h('div', { key: 'l', style: { minWidth: 0, flex: 1 } }, [
                  h('div', { key: 'a', style: { fontSize: T.font, fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } }, [
                    h('span', { key: 't' }, j.title),
                    pendingDelete ? h(Tag, { key: 'p', tone: 'err', title: j.expiredReason },
                      // 用 untilTime：pendingDeleteAt 是**未来**时间，
                      // 用 relTime 会算成负数并显示「刚刚」
                      `待删除 · ${untilTime(j.pendingDeleteAt)}后清`) : null,
                    expired ? h(Tag, { key: 'x', tone: 'err', title: j.expiredReason }, '已过期') : null,
                    willExpire ? h(Tag, { key: 's', tone: 'warn', title: '已超过 15 天未更新，下次打开会自动标记过期' }, '待核实') : null,
                    j.editedByUser ? h(Tag, { key: 'e', tone: 'brand' }, '已手改') : null,
                  ]),
                  // ★ 需求 1：状态 + 最后更新时间，收起态常驻可见
                  h('div', { key: 'b', style: { ...P.muted, marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
                    h('span', { key: 'c' }, j.company),
                    j.city ? h('span', { key: 'ct' }, `· ${j.city}`) : null,
                    h('span', { key: 'u', title: `最后更新：${fullTime(j.updatedAt)}` }, `· 更新于 ${relTime(j.updatedAt)}`),
                    h('span', { key: 'col', title: `记录于：${fullTime(j.collectedAt)}` }, `· 收录于 ${relTime(j.collectedAt)}`),
                  ]),
                ]),
                h('div', { key: 'r', style: { ...P.row, flexShrink: 0 } },
                  h(Tag, { key: 'st', tone: dead ? 'err' : 'ok' },
                    pendingDelete ? '待删除' : expired ? '已过期' : '在招')),
              ]),

              // 需求 11：彩色技术气泡（收起态可见，点击即筛选）
              // 需求 11 + v1.5：彩色技术气泡（收起态可见，点击即筛选）
              // 标签由大模型分析写入；没标签时如实显示「待 AI 分析」并给一键入口，
              // 绝不在前端猜标签（那正是用户不想要的关键词匹配）。
              (() => {
                const ids = (j.businessSkills || []).filter(Boolean);
                if (!ids.length) {
                  return h('div', {
                    key: 'biz', style: { ...P.row, flexWrap: 'wrap', marginTop: 7, gap: 6 },
                  }, [
                    h(Tag, {
                      key: 'none', tone: 'warn',
                      title: j.needsRetagReason
                        || '这条 JD 还没有技术标签。标签由 AI 分析岗位内容得出，点右边按钮让 Agent 补上。',
                    }, j.needsRetag ? '标签已过期' : '待 AI 分析'),
                    h(Btn, {
                      key: 'ask', size: 'sm',
                      title: '把这个 JD 交给 Agent 打标（会带上词表复用约束）',
                      onClick: () => askTag([j]),
                    }, '让 AI 打标'),
                  ]);
                }
                return h('div', {
                  key: 'biz', style: { display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 7, alignItems: 'center' },
                }, [
                  // ⚠️ 不截断到 5 个：「1~5 个」是给 AI 打标的指令，不是展示闸门。
                  // 用户手打了 6 个关键词却只看到 5 个气泡，会以为系统吞了他的数据。
                  ...ids.map((id) => h(TechBubble, {
                    key: id, id,
                    label: tagLabelFor(j, id),
                    labelAlt: tagLabelAlt(j, id),
                    hue: bizHue(id),
                    active: techFilter === id,
                    onClick: () => setTechFilter(techFilter === id ? null : id),
                  })),
                ]);
              })(),

              // 需求 6：关键按钮不展开也能直接看见
              h('div', { key: 'quick', style: { ...P.row, flexWrap: 'wrap', marginTop: 9 } }, [
                dead ? h(Btn, {
                  key: 'rs', onClick: () => restore(j), kind: 'primary', size: 'sm',
                  title: '其实还在招？点这里恢复',
                }, '恢复在招') : h(Btn, {
                  key: 'go', onClick: () => goApply(j), kind: 'primary', size: 'sm',
                  title: j.url ? '打开原网页并记为已投递' : '没有链接，直接记为已投递',
                }, '去投递 ↗'),
                // 需求 10：一键问 AI
                h(Btn, {
                  key: 'ask', onClick: () => askAI(j), size: 'sm',
                  title: '把这条 JD 注入聊天输入框，直接问 AI',
                }, '问 AI'),
                h(Btn, {
                  key: 'e', size: 'sm',
                  onClick: () => { setEditingId(j.id); setEditDraft({}); setOpenId(null); },
                }, '编辑'),
                h(Btn, { key: 'd', onClick: () => del(j), kind: 'danger', size: 'sm' }, '删除'),
              ]),

              isOpen ? h('div', { key: '2', style: { marginTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 10 } }, [
                h('div', { key: 'meta', style: { ...P.muted, marginBottom: 8, lineHeight: 1.75 } }, [
                  h('div', { key: '1' }, `记录于：${fullTime(j.collectedAt)}`),
                  h('div', { key: '2' }, `最后更新：${fullTime(j.updatedAt)}${j.editedByUser ? '（你手动改过）' : ''}`),
                  j.lastCheckedAt ? h('div', { key: '3' },
                    `链接检测：${fullTime(j.lastCheckedAt)} · ${j.linkAlive === true ? '存活' : j.linkAlive === false ? '失效' : '无法确认（可能是反爬）'}`) : null,
                  j.expiredReason ? h('div', { key: '4', style: { color: 'var(--dsw-alias-state-error-primary)' } }, `过期原因：${j.expiredReason}`) : null,
                  j.pendingDeleteAt ? h('div', { key: '5', style: { color: 'var(--dsw-alias-state-error-primary)' } },
                    `将于 ${fullTime(j.pendingDeleteAt)} 之后自动删除（点「恢复在招」可保住）`) : null,
                  h('div', { key: '6' }, `来源：${j.source || '—'}`),
                ]),
                j.url ? h('div', { key: 'u', style: { marginBottom: 8, wordBreak: 'break-all' } },
                  h('a', {
                    href: j.url, target: '_blank', rel: 'noopener noreferrer',
                    style: { color: 'var(--dsw-alias-brand-primary)', fontSize: T.fontSm },
                  }, j.url)) : null,
                j.skills && j.skills.length ? h('div', { key: 'sk', style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 } },
                  j.skills.map((s) => h(Tag, { key: s }, s))) : null,
                j.requirements ? h('div', { key: 'rq', style: { marginBottom: 8 } }, [
                  h('div', { key: 't', style: { fontSize: T.fontSm, fontWeight: 600, marginBottom: 3 } }, '招聘要求'),
                  h('div', { key: 'c', style: { ...P.muted, whiteSpace: 'pre-wrap', lineHeight: 1.65 } }, j.requirements),
                ]) : null,
                j.description ? h('div', { key: 'ds', style: { marginBottom: 8 } }, [
                  h('div', { key: 't', style: { fontSize: T.fontSm, fontWeight: 600, marginBottom: 3 } }, '岗位描述'),
                  h('div', { key: 'c', style: { ...P.muted, whiteSpace: 'pre-wrap', lineHeight: 1.65 } }, j.description),
                ]) : null,
              ]) : null,
            ]);
          }),
        ])) : h(StateBox, {
          key: 'e', empty: true, emptyIcon: '🔍',
          emptyText: items.length
            ? '没有符合筛选条件的 JD。试试清除筛选。'
            : 'JD 池是空的。可以让 Agent 采集，或点「手动录入」。',
        }),
      ]);
    }

    // ───────────────────────── Tab: 技能 ─────────────────────────

    function SkillsTab({ onDirty, toast, confirm, jumpToTab }) {
      const { loading, error, data, reload } = useRpc('getSkills', {}, []);
      // JD 池的热门方向 —— 用来做「市场要什么 vs 我有什么」的差距分析
      const { data: jobData } = useRpc('getJobs', {}, []);
      const [showAdd, setShowAdd] = useState(false);
      const [form, setForm] = useState({ name: '', difficulty: 'medium' });
      const [openId, setOpenId] = useState(null);
      // 「出现几次以上才算差距」由用户调（原先是写死的 2），选择记在 localStorage
      const [gapThreshold, setGapThreshold] = useState(() => {
        try {
          const v = Number(localStorage.getItem('career.gapThreshold'));
          return Number.isFinite(v) && v >= 1 && v <= 20 ? v : 2;
        } catch { return 2; }
      });
      const changeGapThreshold = (v) => {
        const n = Math.max(1, Math.min(20, Number(v) || 2));
        setGapThreshold(n);
        try { localStorage.setItem('career.gapThreshold', String(n)); } catch { /* 隐私模式忽略 */ }
      };
      // 选难度的弹窗复用共享的 confirm()（带 render/onConfirm），不另开弹窗状态

      if (loading) return h(StateBox, { loading: true });
      if (error) return h(StateBox, { error, onRetry: reload });
      if (!data) return h(StateBox, { loading: true, onRetry: reload });

      const items = (data && data.items) || [];
      const states = (data && data.states) || {};
      const due = (data && data.due) || [];
      const dueIds = new Set(due.map((d) => d.id));

      /**
       * 差距分析：JD 池里出现 ≥gapThreshold 次、但技能清单里还没有的方向。
       * 这是「聊着聊着就懂用户」最直接的落点 —— 不用用户自己想该学什么。
       *
       * 阈值由用户在界面上调（需求：不要写死 2 次），存 localStorage 记住选择。
       */
      const gaps = (() => {
        const freq = ((jobData && jobData.buckets && jobData.buckets.tagFreq) || [])
          .filter((b) => b.count >= gapThreshold);
        const mine = items.map((s) => String(s.name || '').toLowerCase());
        return freq.filter((b) => !mine.includes(String(b.label || '').toLowerCase())).slice(0, 10);
      })();

      /**
       * 点「加入计划」→ 弹窗选难度 → 确认后才写入。
       * 难度不直接摆在气泡上（用户要求：点一下再问）。
       *
       * v1.5.6：下拉框换成**三个单选按钮**（用户原话「不需要一个下拉框，
       * 3 个单选按钮就可以了」）——点一下就改选中态，不用再展开下拉。
       */
      async function askDifficulty(b) {
        const picked = await confirm({
          title: `加入计划：${b.label}`,
          message: `JD 池里有 ${b.count} 个岗位要求这个方向。选个难度，计划截止日会按它排。`,
          defaultValue: 'medium',
          confirmText: '加入',
          cancelText: '取消',
          render: (text, setText) => h('div', {
            key: 'r', style: { display: 'flex', gap: 8, flexWrap: 'wrap' },
          }, [
            ['easy', '简单', '约 1 周上手'],
            ['medium', '中等', '约 3 周上手'],
            ['hard', '困难', '约 1 个半月上手'],
          ].map(([v, label, hint]) => {
            const on = (text || 'medium') === v;
            return h('button', {
              key: v,
              type: 'button',
              onClick: () => setText(v),
              style: {
                cursor: 'pointer',
                padding: '8px 12px', borderRadius: 8, textAlign: 'left',
                border: `1px solid ${on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
                background: on ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                color: 'var(--dsw-alias-label-primary)',
                display: 'flex', flexDirection: 'column', gap: 2,
                minWidth: 92,
              },
            }, [
              h('span', { key: 'l', style: { fontWeight: on ? 700 : 400, fontSize: T.font } },
                `${on ? '● ' : '○ '}${label}`),
              h('span', { key: 's', style: { ...P.muted, fontSize: T.fontSm } }, hint),
            ]);
          })),
          onConfirm: (text) => text || 'medium',
        });
        if (picked) await adoptGap(b, picked);
      }

      async function adoptGap(b, difficulty) {
        try {
          await call('addSkill', {
            skill: {
              name: b.label,
              difficulty,
              proposedBy: 'ai',
              // ⚠️ 数据层要的是 `reason`（AI 提议必须给依据），不是 `note`。
              //    这里原先传 note，于是每次点「加入计划」都被
              //    「AI 提议技能必须提供 reason」挡下来 —— 按钮从来没成功过。
              reason: `JD 池里有 ${b.count} 个岗位要求「${b.label}」`,
            },
          });
          reload(); onDirty && onDirty();
          const label = { easy: '简单', medium: '中等', hard: '困难' }[difficulty] || difficulty;
          toast(`已把「${b.label}」加进学习计划（难度：${label}）`, 'success');
        } catch (e) { toast('添加失败：' + ((e && e.message) || e), 'error'); }
      }

      async function askGapPlan() {
        const list = gaps.slice(0, 6).map((b) => `${b.label}（${b.count} 个岗位）`).join('、');
        const text = `JD 池里这些方向要求最多，而我还没有记录：${list}。\n`
          + `请结合我已有的技能和画像，帮我把它们排出学习优先级（先学哪个、为什么），`
          + `并给每个方向一个可执行的入门路径。`;
        if (await confirmThenFill(text, confirm)) toast('已把差距分析进粘贴到剪切板，请在职业规划预设中，按Ctrl+V复制到聊天框中，发送给 Agent,即可让 AI 排优先级', 'success');
        else toast('没找到聊天输入框，请在对话里直接问「我该先学什么」', 'info');
      }

      async function add() {
        if (!form.name.trim()) { toast('请填写技能名', 'error'); return; }
        try {
          await call('addSkill', { skill: { name: form.name.trim(), difficulty: form.difficulty, proposedBy: 'user' } });
          setForm({ name: '', difficulty: 'medium' }); setShowAdd(false); reload(); onDirty && onDirty();
          toast('已添加，截止日已按难度排好', 'success');
        } catch (e) { toast('添加失败：' + ((e && e.message) || e), 'error'); }
      }

      async function del(s) {
        const ok = await confirm({
          title: '删除技能',
          message: `删除「${s.name}」及其全部考试记录？此操作不可撤销。`,
          confirmText: '删除', danger: true,
        });
        if (!ok) return;
        try { await call('deleteSkill', { id: s.id }); reload(); onDirty && onDirty(); toast('已删除', 'success'); }
        catch (e) { toast('删除失败：' + ((e && e.message) || e), 'error'); }
      }

      // v1.5.3：原先这里有 setStatus()（手动改状态的下拉），
      // 已删除 —— 状态只能由考核结果决定（record_exam），手动改会绕开铁律。

      const byStatus = new Map();
      for (const s of items) {
        if (!byStatus.has(s.status)) byStatus.set(s.status, []);
        byStatus.get(s.status).push(s);
      }

      return h('div', null, [
        due.length ? h(Section, {
          key: 'due', title: '超期提醒', count: due.length,
          right: [h(Tag, { key: 't', tone: 'warn' }, '该考核了')],
        }, due.map((d) => h(Card, { key: d.id, highlight: true },
          h('div', { key: 'a', style: { fontSize: T.font } }, [
            h('div', { key: 'n', style: { fontWeight: 600 } }, d.name),
            h('div', { key: 'd', style: { ...P.muted, marginTop: 3 } },
              (() => {
                const left = daysLeft(d.targetDate);
                const over = left !== null && left < 0 ? `（已超期 ${Math.abs(left)} 天）` : '';
                return `计划截止日 ${d.targetDate}${over}`;
              })()),
            h('div', { key: 'h', style: { ...P.muted, marginTop: 5, lineHeight: 1.6 } },
              '让 Agent 对这个技能发起考核（它当面试官提问、打分），通过后才会标记完成。'),
          ])))) : null,

        // ★ 差距分析：市场要什么 vs 我记录了什么
        // 注意：**无论有没有差距都要渲染**，否则阈值的调节入口在"没有差距"时消失，
        // 用户就永远没法把阈值调低来看更细的方向。
        h(Section, {
          key: 'gap', title: 'JD 要求但我还没记录',
          count: gaps.length,
          right: [
            h('span', { key: 'thl', style: { ...P.muted, fontSize: T.fontSm } }, '出现次数 ≥'),
            h(Select, {
              key: 'th', value: String(gapThreshold), onChange: changeGapThreshold,
              options: [1, 2, 3, 4, 5, 8, 10].map((n) => ({ value: String(n), label: String(n) })),
              style: { maxWidth: 68 },
            }),
            h(Btn, { key: 'ask', onClick: askGapPlan, size: 'sm' }, '让 AI 排优先级'),
          ],
        }, [
          h('div', { key: 'tip', style: { ...P.muted, marginBottom: 8, lineHeight: 1.6 } },
            `JD 池里出现 ${gapThreshold} 次以上、但你的技能清单里还没有的方向。`
            + '点「加入计划」会按热度自动定难度和截止日。'
            + '（左边的数字可以调：调低会看到更细的方向，调高只留最集中的）'),
          gaps.length ? h('div', { key: 'c', style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            gaps.map((b) => h('div', {
              key: b.id,
              style: {
                display: 'flex', alignItems: 'center', gap: 5,
                border: `1px solid ${tagColor(b.hue, 0.3)}`,
                background: tagColor(b.hue, 0.07),
                borderRadius: 999, padding: '3px 5px 3px 10px',
              },
            }, [
              h('span', { key: 'l', style: { fontSize: 11.5, color: tagColor(b.hue), fontWeight: 600 } },
                `${b.label} (${b.count})`),
              // 难度不在气泡上选：点了「加入计划」再弹窗问（用户要求）
              h(Btn, {
                key: 'add', size: 'sm', onClick: () => askDifficulty(b),
                title: `选个难度，然后把「${b.label}」加进学习计划`,
              }, '加入计划'),
              h(Btn, {
                key: 'jd', size: 'sm', onClick: () => gotoJobsWithTag(b.id, jumpToTab),
                title: '看看哪些岗位要这个',
              }, '看 JD'),
            ])))
            : h('div', { key: 'e', style: P.muted },
              `暂时没有出现 ${gapThreshold} 次以上、且你还没记录的方向 —— 可以把左边的次数调低试试。`),
        ]),

        h(Section, {
          key: 'hd', title: '技能清单', count: items.length,
          right: [h(Btn, { key: 'a', onClick: () => setShowAdd(!showAdd), kind: showAdd ? 'default' : 'primary' }, showAdd ? '取消' : '+ 添加技能')],
        }, showAdd ? h(Card, { key: 'f', style: { background: 'var(--dsw-alias-bg-layer-2)' } }, [
          h('div', { key: '1', style: { ...P.row, marginBottom: 6 } }, [
            h(Input, { key: 'a', value: form.name, onChange: (v) => setForm({ ...form, name: v }), placeholder: '技能名（如 Redis）' }),
            h(Select, {
              key: 'b', value: form.difficulty, onChange: (v) => setForm({ ...form, difficulty: v }),
              options: [{ value: 'easy', label: '简单' }, { value: 'medium', label: '中等' }, { value: 'hard', label: '困难' }],
              style: { maxWidth: 88 },
            }),
          ]),
          h('div', { key: '2', style: { ...P.muted, marginBottom: 6 } },
            '计划截止日会按难度与当前在学数量自动推算。'),
          h(Btn, { key: '3', onClick: add, kind: 'primary' }, '保存'),
        ]) : null),

        // v1.5.3：状态只剩「在学 / 已通过」两种（由考核结果决定，不能手动改）
        items.length ? ['learning', 'done'].filter((k) => byStatus.has(k)).map((k) =>
          h('div', { key: k, style: { marginBottom: 14 } }, [
            h('div', { key: 'h', style: { ...P.row, marginBottom: 6 } }, [
              h(Tag, { key: 't', tone: k === 'done' ? 'ok' : 'default' }, states[k] || k),
              // 需求 5：计数用 ()
              h('span', { key: 'c', style: P.muted }, `(${byStatus.get(k).length})`),
            ]),
            ...byStatus.get(k).map((s) => {
              const isOpen = openId === s.id;
              const exams = s.exams || [];
              return h(Card, { key: s.id, highlight: dueIds.has(s.id) }, [
                h('div', { key: '1', style: { display: 'flex', justifyContent: 'space-between', gap: 8 } }, [
                  h('div', {
                    key: 'l', style: { cursor: 'pointer', flex: 1, minWidth: 0 },
                    onClick: () => setOpenId(isOpen ? null : s.id),
                  }, [
                    h('div', { key: 'a', style: { fontSize: T.font, fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } }, [
                      h('span', { key: 'n' }, s.name),
                      h(Tag, {
                        key: 'd',
                        tone: s.difficulty === 'hard' ? 'err' : s.difficulty === 'easy' ? 'ok' : 'default',
                      }, s.difficulty === 'hard' ? '困难' : s.difficulty === 'easy' ? '简单' : '中等'),
                      s.proposedBy === 'ai' ? h(Tag, { key: 'ai', tone: 'brand' }, 'AI 提议') : null,
                      // 需求 5：计数用 ()
                      exams.length ? h(Tag, { key: 'e' }, `(考核 ${exams.length} 次)`) : null,
                    ]),
                    // 需求：外部只说「还剩几天」，不直接展示日期（日期放展开里）
                    h('div', { key: 'b', style: { ...P.muted, marginTop: 4 } },
                      (() => {
                        if (k === 'done') return `已通过 · ${isOpen ? '收起' : '展开'}`;
                        const left = daysLeft(s.targetDate);
                        if (left === null) return `未设定计划截止日 · ${isOpen ? '收起' : '展开'}`;
                        if (left < 0) return `⚠️ 已超期 ${Math.abs(left)} 天 · ${isOpen ? '收起' : '展开'}`;
                        return `距结束还有 ${left} 天 · ${isOpen ? '收起' : '展开'}`;
                      })()),
                  ]),
                  // 需求 6：删除按钮不展开也能看见
                  // v1.5.3：状态只由考核决定，**不提供手动改状态的下拉**
                  h('div', { key: 'r', style: { ...P.row, flexShrink: 0 } }, [
                    h(Btn, { key: 'd', onClick: () => del(s), kind: 'danger', size: 'sm', title: '删除技能' }, '删除'),
                  ]),
                ]),
                isOpen ? h('div', { key: '2', style: { marginTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 10 } }, [
                  // 需求：日期信息只在展开时看（外部只显示剩余天数）
                  h('div', { key: 'dt', style: { ...P.muted, fontSize: T.fontSm, lineHeight: 1.7, marginBottom: 8 } }, [
                    h('div', { key: 'a' }, `加入计划：${String(s.startDate || s.createdAt || '').slice(0, 10) || '—'}`),
                    h('div', { key: 'b' }, `计划截止：${s.targetDate || '—'}`),
                  ]),
                  exams.length ? h('div', { key: 'ex' }, [
                    h('div', { key: 't', style: { fontSize: T.fontSm, fontWeight: 600, marginBottom: 6 } }, '考核记录'),
                    ...exams.map((e, i) => h('div', {
                      key: i,
                      style: {
                        fontSize: T.fontSm, padding: '8px 10px', borderRadius: T.radius, marginBottom: 5,
                        background: 'var(--dsw-alias-bg-layer-2)',
                      },
                    }, [
                      h('div', { key: 'a', style: { ...P.row, marginBottom: 4 } }, [
                        h(Tag, { key: 'p', tone: e.passed ? 'ok' : 'err' }, e.passed ? '通过' : '未通过'),
                        h('span', { key: 's', style: { fontWeight: 600 } }, `${e.score} 分`),
                        h('span', { key: 'd', style: { color: 'var(--dsw-alias-label-secondary)' } }, String(e.at || '').slice(0, 10)),
                        e.difficulty ? h('span', {
                          key: 'df', style: { color: 'var(--dsw-alias-label-secondary)' },
                        }, `当时难度：${e.difficulty === 'hard' ? '困难' : e.difficulty === 'easy' ? '简单' : '中等'}`) : null,
                      ]),
                      // 每次答题情况（v1.5.3：AI 必须把每题作答与点评写进来）
                      (e.items || []).length ? h('div', { key: 'it', style: { margin: '4px 0 2px' } },
                        e.items.map((it, j) => h('div', {
                          key: j, style: { lineHeight: 1.6, marginBottom: 4, color: 'var(--dsw-alias-label-secondary)' },
                        }, [
                          h('div', { key: 'q' }, `Q${j + 1} ${it.q || ''}`),
                          it.answer ? h('div', { key: 'a' }, `我的回答：${it.answer}`) : null,
                          it.feedback ? h('div', { key: 'f' }, `点评：${it.feedback}`) : null,
                        ]))) : null,
                      e.weakPoints && e.weakPoints.length
                        ? h('div', { key: 'w', style: { color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 } }, `待改进：${e.weakPoints.join('；')}`) : null,
                      e.advice ? h('div', { key: 'ad', style: { color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 } }, `建议：${e.advice}`) : null,
                    ])),
                  ]) : h('div', { key: 'noex', style: { ...P.muted, marginBottom: 8 } }, '还没有考核记录。可以让 Agent 当面试官考核你。'),
                  h('div', { key: 'act', style: P.row }, [
                    h(Btn, {
                      key: 'ex', size: 'sm', kind: 'primary',
                      onClick: async () => {
                        const diffZh = s.difficulty === 'hard' ? '困难' : s.difficulty === 'easy' ? '简单' : '中等';
                        const text = `帮我考核「${s.name}」这个技能。\n`
                          + `这个技能我标的难度是**${diffZh}**，请按${diffZh}难度出题（不要出得太简单或太偏），`
                          + `你要像一个技术面试官一样，可以结合实际JD池的相关JD要求和画像，不断地给我出题，你出一道，我答一道，可以追问。直到达到可以开始评分的标准，最多10道题或用户提出结束：\n`
                          + `1) 按 100 分制打分并给出「通过/未通过」；\n`
                          + `2) 调 career_write 的 record_exam 写回：每题记 {q,answer,feedback}、`
                          + `整体给 score、advice、weakPoints、passed；\n`
                          + `3) 未通过时保持「在学」状态不变即可（系统会自动顺延截止日）。`;
                        if (await confirmThenFill(text, confirm)) toast('已把考核请求进粘贴到剪切板，请在职业规划预设中，按Ctrl+V复制到聊天框中，发送给 Agent，开始考核', 'success');
                        else toast('没找到聊天输入框，请在对话里直接说「考核一下 ' + s.name + '」', 'info');
                      },
                      title: `让 AI 按「${s.difficulty === 'hard' ? '困难' : s.difficulty === 'easy' ? '简单' : '中等'}」难度当面试官考你，通过后才会标记已通过`,
                    }, '让 AI 考核我'),
                  ]),
                ]) : null,
              ]);
            }),
          ])
        ) : h(StateBox, {
          key: 'e', empty: true, emptyIcon: '📚',
          emptyText: '技能清单是空的。可以让 Agent 根据 JD 池的缺口给你推荐该学什么。',
        }),
      ]);
    }

    // ───────────────────────── Tab: 简历 / 图谱 / 词表 ─────────────────────────
    //
    // 注：这里原先有个「变更审计」面板 + `auditLine()` 中文化函数，
    // 已按用户要求删除（与求职动作无关，且与卡片上的「更新于 / 已过期」信息重复）。
    // 审计**日志照旧写**，Host 的 `getEvents` 也保留 —— 排查和追责要用。


    function ResumesTab({ onDirty, toast, confirm, jumpToTab }) {
      const { loading, error, data, reload } = useRpc('getResumes', {}, []);
      const { data: graph, reload: reloadGraph } = useRpc('getGraph', {}, []);
      const [preview, setPreview] = useState(null);
      const [graphMsg, setGraphMsg] = useState(null);
      const [uploading, setUploading] = useState(false);
      const [dragging, setDragging] = useState(false);
      const fileRef = useRef(null);

      // ★ 注意：Host 的 getResumes 返回的是**数组**，不是 { items }。
      // 这里写成 `Array.isArray(x) ? x : (x && x.items) || []` 兼容两种形状，
      // 免得以后再改 Host 返回值时静默变成空列表。（这个坑真踩过，见开发文档 §7.13）
      const items = Array.isArray(data) ? data : ((data && data.items) || []);

      async function rebuildGraph() {
        try {
          const g = await call('rebuildGraph', {});
          // v1.2：技术与业务能力已合并为一层，`topSkills` 恒为空数组。
          // 这里必须读 topTech（旧代码读 topSkills 会永远显示「0 个技术栈」）。
          const tech = (g.topTech || g.topBusinessSkills || []).length;
          const groups = new Set((g.topTech || g.topBusinessSkills || []).map((t) => t.group).filter(Boolean)).size;
          const tagCount = (g.tagIndex || []).length;
          setGraphMsg(`已重算：基于 ${g.basedOnJobs} 条 JD，`
            + `产出 ${tech} 个技术方向（覆盖 ${groups} 个分组）`
            + (tagCount ? `，共 ${tagCount} 个可点击标签` : ''));
          reloadGraph(); onDirty && onDirty();
          toast('技能图谱已重算', 'success');
          setTimeout(() => setGraphMsg(null), 6000);
        } catch (e) { toast('重算失败：' + ((e && e.message) || e), 'error'); }
      }

      async function openResume(r) {
        try {
          const res = await call('readResumeText', { name: r.name });
          setPreview({ name: r.name, text: res.text, note: res.note, fromParsed: res.fromParsed });
        } catch (e) { toast('读取失败：' + ((e && e.message) || e), 'error'); }
      }

      /** 需求 5：上传简历（拖拽或点击） */
      async function uploadFiles(files) {
        const list = Array.from(files || []);
        if (!list.length) return;
        setUploading(true);
        let ok = 0;
        for (const f of list) {
          try {
            const buf = await f.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let bin = '';
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
              bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            const b64 = window.btoa(bin);
            await call('uploadResume', { name: f.name, contentBase64: b64 });
            ok += 1;
          } catch (e) {
            toast(`「${f.name}」上传失败：${(e && e.message) || e}`, 'error');
          }
        }
        setUploading(false);
        if (ok) {
          reload(); onDirty && onDirty();
          toast(`已上传 ${ok} 个文件`, 'success');
        }
      }

      async function delResume(r) {
        const ok = await confirm({
          title: '删除简历',
          message: `删除「${r.name}」及其解析文本？此操作不可撤销。`,
          confirmText: '删除', danger: true,
        });
        if (!ok) return;
        try { await call('deleteResume', { name: r.name }); reload(); onDirty && onDirty(); toast('已删除', 'success'); }
        catch (e) { toast('删除失败：' + ((e && e.message) || e), 'error'); }
      }

      return h('div', null, [
        h(Section, { key: 'up', title: '简历上传' }, [
          h('div', {
            key: 'drop',
            onDragOver: (e) => { e.preventDefault(); setDragging(true); },
            onDragLeave: () => setDragging(false),
            onDrop: (e) => { e.preventDefault(); setDragging(false); uploadFiles(e.dataTransfer.files); },
            onClick: () => fileRef.current && fileRef.current.click(),
            style: {
              border: `2px dashed ${dragging ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
              borderRadius: T.radiusLg,
              padding: '22px 16px',
              textAlign: 'center',
              cursor: uploading ? 'wait' : 'pointer',
              background: dragging ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent)' : 'transparent',
              transition: 'all .18s ease',
            },
          }, [
            h('div', { key: 'i', style: { fontSize: 24, marginBottom: 8, opacity: 0.5 } }, uploading ? '◌' : '📎'),
            h('div', { key: 't', style: { fontSize: T.font, fontWeight: 600, marginBottom: 4 } },
              uploading ? '正在上传…' : '点击选择，或把简历拖到这里'),
            h('div', { key: 's', style: P.muted }, '支持 PDF / DOC / DOCX / MD / TXT / 图片，单个不超过 10MB'),
            h('input', {
              key: 'f', ref: fileRef, type: 'file', multiple: true,
              accept: '.pdf,.doc,.docx,.md,.txt,.rtf,.png,.jpg,.jpeg',
              style: { display: 'none' },
              onChange: (e) => { uploadFiles(e.target.files); e.target.value = ''; },
            }),
          ]),
        ]),

        // h(Section, { key: 'r', title: '我的简历', count: items.length },
        //   loading ? h(StateBox, { loading: true })
        //     : error ? h(StateBox, { error, onRetry: reload })
        //       : items.length ? items.map((r) => h(Card, { key: r.name }, [
        //         h('div', { key: 'a', style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } }, [
        //           h('div', { key: 'l', style: { minWidth: 0 } }, [
        //             h('div', { key: 'n', style: { fontSize: T.font, fontWeight: 600, wordBreak: 'break-all' } }, r.name),
        //             h('div', { key: 'm', style: { ...P.muted, marginTop: 3 } },
        //               // ⚠️ 用 `readable`，不是 `hasParsed`：
        //               //   hasParsed 是早期"让 Agent 手写解析结果"时代的遗留字段，
        //               //   只认 `<名>.parsed.txt` 一个文件；而现在上传走的是**自动转 .md**，
        //               //   根本不产 .parsed.txt → 用它会导致「永远显示未解析」。
        //               //   readable = .md 或 .parsed.txt 任一存在（这才是"已解析"的准确定义）。
        //               `${(r.size / 1024).toFixed(1)} KB · ${relTime(r.modifiedAt)}${r.readable ? ' · 已解析' : ' · 未解析'}`),
        //           ]),
        //           h('div', { key: 'r', style: { ...P.row, flexShrink: 0 } }, [
        //             h(Btn, { key: 'v', onClick: () => openResume(r), size: 'sm' }, '查看'),
        //             h(Btn, { key: 'd', onClick: () => delResume(r), kind: 'danger', size: 'sm' }, '删除'),
        //           ]),
        //         ]),
        //       ])) : h(StateBox, {
        //         key: 'n', empty: true, emptyIcon: '📄',
        //         emptyText: '还没有简历。上传后 Agent 可以据此补充你的画像。',
        //       })),

        // preview ? h(Section, {
        //   key: 'pv', title: `预览：${preview.name}`,
        //   right: [h(Btn, { key: 'c', onClick: () => setPreview(null) }, '关闭')],
        // }, [
        //   preview.text ? h('pre', {
        //     key: 't',
        //     style: {
        //       fontSize: T.fontSm, whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto',
        //       background: 'var(--dsw-alias-bg-layer-2)', padding: 10, borderRadius: T.radius, margin: 0,
        //       lineHeight: 1.6,
        //     },
        //   }, preview.text.slice(0, 5000))
        //     : h('div', { key: 'nt', style: { ...P.muted, lineHeight: 1.6 } },
        //       preview.note || '无法显示文本内容。可以让 Agent 用工具解析这个文件。'),
        // ]) : null,
        h(Section, { key: 'r', title: '我的简历', count: items.length },
          loading ? h(StateBox, { loading: true })
            : error ? h(StateBox, { error, onRetry: reload })
              : items.length ? items.map((r) => h(Card, { key: r.name }, [
                h('div', { key: 'a', style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } }, [
                  h('div', { key: 'l', style: { minWidth: 0 } }, [
                    h('div', { key: 'n', style: { fontSize: T.font, fontWeight: 600, wordBreak: 'break-all' } }, r.name),
                    h('div', { key: 'm', style: { ...P.muted, marginTop: 3 } },
                      // ⚠️ 用 readable，不是 hasParsed：
                      //   hasParsed 是早期"让 Agent 手写解析结果"时代的遗留字段，
                      //   只认 <名>.parsed.txt 一个文件；而现在上传走的是自动转 .md，
                      //   根本不产 .parsed.txt → 用它会导致「永远显示未解析」。
                      //   readable = .md 或 .parsed.txt 任一存在（这才是"已解析"的准确定义）。
                      `${(r.size / 1024).toFixed(1)} KB · ${relTime(r.modifiedAt)}${r.readable ? ' · 已解析' : ' · 未解析'}`),
                  ]),
                  h('div', { key: 'r', style: { ...P.row, flexShrink: 0 } }, [
                    h(Btn, {
                      key: 'v',
                      onClick: () => {
                        // 点击同一条：取消预览；点击其他：切换为当前预览
                        if (preview && preview.name === r.name) {
                          setPreview(null)
                        } else {
                          openResume(r)
                        }
                      },
                      size: 'sm'
                    }, preview && preview.name === r.name ? '取消预览' : '预览'),
                    h(Btn, { key: 'd', onClick: () => delResume(r), kind: 'danger', size: 'sm' }, '删除'),
                  ]),
                ]),
                // 当前卡片是预览对象，追加预览文本区域
                (preview && preview.name === r.name) ? h('div', { key: 'pv', style: { marginTop: 10 } }, [
                  preview.text ? h('pre', {
                    key: 't',
                    style: {
                      fontSize: T.fontSm, whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto',
                      background: 'var(--dsw-alias-bg-layer-2)', padding: 10, borderRadius: T.radius, margin: 0,
                      lineHeight: 1.6,
                    },
                  }, preview.text.slice(0, 5000))
                    : h('div', { key: 'nt', style: { ...P.muted, lineHeight: 1.6 } },
                      preview.note || '无法显示文本内容。可以让 Agent 用工具解析这个文件。'),
                ]) : null,
              ])) : h(StateBox, {
                key: 'n', empty: true, emptyIcon: '📄',
                emptyText: '还没有简历。上传后 Agent 可以据此补充你的画像。',
              })),
        // 移除原来独立的 preview Section


        // ── 需求 11：技术栈图谱（业务能力与技术栈已合并为一层） ──
        h(Section, {
          key: 'g', title: '技术栈图谱',
          right: [h(Btn, { key: 'rb', onClick: rebuildGraph, kind: 'primary' }, '重算')],
        }, [
          h('div', { key: 'h', style: { ...P.muted, marginBottom: 10, lineHeight: 1.6 } },
            `从 JD 池提炼的具体技术方向（Agent RL / RAG / 多模态后训练…），每条 JD 最多 5 个。点气泡可直接筛出相关 JD。`),
          graphMsg ? h('div', {
            key: 'm', style: { fontSize: T.fontSm, color: 'var(--dsw-alias-state-success-primary)', marginBottom: 8 },
          }, graphMsg) : null,

          graph && (graph.topTech || graph.topBusinessSkills || []).length ? h('div', { key: 'biz' }, [
            h('div', { key: 't', style: { fontSize: T.fontSm, fontWeight: 600, marginBottom: 7 } },
              `🎯 方向热度 (${(graph.topTech || graph.topBusinessSkills || []).length})`),
            ...(graph.topTech || graph.topBusinessSkills || []).slice(0, 15).map((b) => {
              const pct = Math.min(100, b.share || 0);
              const hue = typeof b.hue === 'number' ? b.hue : bizHue(b.id);
              return h('div', {
                key: b.id || b.skill, style: { marginBottom: 7, cursor: 'pointer' },
                onClick: () => gotoJobsWithTag(b.id, jumpToTab),
                title: `点击查看「${b.skill}」方向的 ${b.count} 条 JD`,
              }, [
                h('div', { key: 'r', style: { display: 'flex', justifyContent: 'space-between', fontSize: T.fontSm, marginBottom: 3, gap: 8 } }, [
                  h('span', { key: 'l', style: { display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 } }, [
                    // 需求 11：技术栈专属颜色
                    h('span', {
                      key: 'dot',
                      style: { width: 8, height: 8, borderRadius: 999, background: tagColor(hue), flexShrink: 0 },
                    }),
                    h('span', { key: 'n', style: { fontWeight: 600 } }, b.skill),
                    b.group ? h(Tag, { key: 'g' }, b.group) : null,
                  ]),
                  h('span', { key: 'v', style: { color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 } },
                    `(${b.count} 个岗位 · ${b.share}%)`),
                ]),
                h('div', {
                  key: 'bar',
                  style: { height: 5, borderRadius: 3, background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden' },
                }, h('div', {
                  style: {
                    width: `${Math.max(3, pct)}%`, height: '100%',
                    background: tagColor(hue), borderRadius: 3,
                    transition: 'width .3s ease',
                  },
                })),
              ]);
            }),
          ]) : null,

          // 需求 11：全部标签做成彩色气泡，点击即跳转筛选
          graph && (graph.tagIndex || []).length ? h('div', { key: 'tech', style: { marginTop: 14 } }, [
            h('div', { key: 't', style: { fontSize: T.fontSm, fontWeight: 600, marginBottom: 7 } },
              `🔖 全部技术标签 (${(graph.tagIndex || []).length})`),
            h('div', { key: 'c', style: { display: 'flex', gap: 5, flexWrap: 'wrap' } },
              (graph.tagIndex || []).slice(0, 40).map((s) => h(TechBubble, {
                key: s.id, id: s.id, label: s.label, hue: s.hue, count: s.count,
                title: `${s.group || ''} · 点一下看相关 JD`,
                onClick: () => gotoJobsWithTag(s.id, jumpToTab),
              }))),
            h('div', { key: 'tip', style: { ...P.muted, marginTop: 7, fontSize: 10.5, lineHeight: 1.55 } },
              '不同颜色 = 不同技术方向。点任意气泡会自动切到「JD 池」并只看该方向的岗位。'),
          ]) : null,

          graph ? h('div', { key: 'sum', style: { ...P.muted, marginTop: 12, fontSize: 10.5 } },
            `图谱版本 v${graph.version || 1} · 基于 ${graph.basedOnJobs || 0} 条 JD · 生成于 ${fullTime(graph.generatedAt)}`) : null,

          !graph || (!(graph.topTech || graph.topBusinessSkills || []).length && !(graph.tagIndex || []).length)
            ? h(StateBox, { key: 'n', empty: true, emptyIcon: '🕸️', emptyText: '图谱还没生成。先往 JD 池里加数据，再点「重算」。' })
            : null,
        ]),

        // 「标签词表」面板已在 v1.5.1 删除：它和上面的「全部技术标签 / 方向热度」
        // 是同一批数据（都来自图谱 tagIndex + 词表），只是换了个排布，属于重复展示。
        // ⚠️ **词表数据层、以及 Host 的 getTaxonomy / mergeTaxonomyTerms 全部保留** ——
        //    打标复用、同义词归并都靠它们，删的只是这块重复的面板。
        //    要看词表：`career_read({ kind: 'taxonomy' })`。

        // 「变更审计」面板已在 v1.5.1 删除：用户不会在投递时读 `rebuild skill_graph`，
        // 而且卡片本身已显示「已过期 · 更新于 …」，属于重复信息。
        // ⚠️ **日志照旧写**（`career/logs/events.jsonl` + Host 的 `getEvents`）——
        //    三把铁律里"未确认的推断不能变成事实"要靠它追责，排查也要靠它。
        //    要看历史：`career_read({ kind: 'events' })`，或直接开 jsonl。
      ]);
    }

    // ───────────────────────── 悬浮窗主体 ─────────────────────────

    const TABS = [
      { key: 'profile', label: '画像', Comp: ProfileTab },
      { key: 'applications', label: '投递', Comp: ApplicationsTab },
      { key: 'jobs', label: 'JD 池', Comp: JobsTab },
      { key: 'skills', label: '技能', Comp: SkillsTab },
      { key: 'resumes', label: '简历/图谱', Comp: ResumesTab },
    ];

    /**
     * 工作台主体：渲染在**右侧边栏**的「职业规划」tab 里。
     *
     * v1.6.1：从"可拖动缩放的悬浮窗"改成右侧边栏面板 ——
     * 位置和大小由侧边栏决定，固定不可动（和点文件后的预览是同一个位置）。
     * 所以这里不再有窗口外壳：没有拖动、缩放、关闭按钮，也不存窗口位置。
     */
    function Workbench() {
      const [tab, setTab] = useState(() => {
        try { return window.localStorage.getItem(LS_TAB) || 'profile'; } catch { return 'profile'; }
      });
      const [ver, setVer] = useState(0);
      const [toasts, setToasts] = useState([]);
      const [modal, setModal] = useState(null);
      const toastSeq = useRef(0);
      const modalResolve = useRef(null);

      useEffect(() => { try { window.localStorage.setItem(LS_TAB, tab); } catch { /* 忽略 */ } }, [tab]);

      const bump = useCallback(() => setVer((v) => v + 1), []);

      const [meta, setMeta] = useState(null);

      /** Toast（需求 6：取代 window.alert） */
      const toast = useCallback((text, kind = 'info') => {
        const id = ++toastSeq.current;
        setToasts((t) => [...t, { id, text: String(text), kind }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 5200 : 2800);
      }, []);

      // 点浮层空白处 / 点提示本身 → 关掉（不传 id = 全关）
      const dismissToasts = useCallback((id) => {
        setToasts((t) => (id === undefined ? [] : t.filter((x) => x.id !== id)));
      }, []);

      /** Confirm（需求 6：取代 window.confirm） */
      const confirm = useCallback((opts) => new Promise((resolve) => {
        modalResolve.current = resolve;
        setModal(typeof opts === 'string' ? { title: opts } : opts);
      }), []);

      const closeModal = useCallback((result) => {
        setModal(null);
        const r = modalResolve.current;
        modalResolve.current = null;
        if (r) r(result);
      }, []);

      // 词表/状态机元数据只拉一次，存进模块级缓存供 bizLabel / bizHue 使用（需求 11）
      useEffect(() => {
        let alive = true;
        call('getMeta', {}).then((m) => {
          if (!alive) return;
          rememberMeta(m);
          setMeta(m);
        }).catch(() => { /* 拉不到就退回兜底映射 */ });
        return () => { alive = false; };
      }, []);

      /**
       * 需求 9：打开工作台时自动跑一次维护——
       *   超过 15 天没更新的 JD → 标记过期；待删除且过了宽限期的 → 真删。
       * 让用户不用手动点，这就是"解放双手"的那一步。
       */
      useEffect(() => {
        let alive = true;
        call('runMaintenance', { staleDays: 15, graceDays: 1 }).then((r) => {
          if (!alive || !r) return;
          if (r.expired > 0 || r.purged > 0) bump();
          if (r.purged > 0) {
            toast(`已清理 ${r.purged} 条确认失效的 JD：${(r.purgedTitles || []).join('、')}`, 'info');
          }
        }).catch(() => { /* 维护失败不打扰用户；Host 半区未升级时会走到这里 */ });
        return () => { alive = false; };
      }, [bump, toast]);

      const active = TABS.find((t) => t.key === tab) || TABS[0];

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column',
          height: '100%', width: '100%', minHeight: 0,
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
          fontSize: T.font,
          position: 'relative',
        },
      }, [
        h('div', {
          key: 'tabs',
          style: {
            display: 'flex', gap: 2, padding: '7px 10px 0',
            borderBottom: '1px solid var(--dsw-alias-border-l1)', flex: '0 0 auto', overflowX: 'auto',
          },
        }, TABS.map((t) => h('button', {
          key: t.key, onClick: () => setTab(t.key),
          style: {
            border: 'none', background: 'transparent', cursor: 'pointer',
            padding: '6px 10px', fontSize: T.font, whiteSpace: 'nowrap',
            color: tab === t.key ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
            borderBottom: `2px solid ${tab === t.key ? 'var(--dsw-alias-brand-primary)' : 'transparent'}`,
            fontWeight: tab === t.key ? 600 : 400,
            transition: 'color .15s ease',
          },
        }, t.label))),

        // ⚠️ key 只含 tab 名，绝不能带 ver
        h('div', {
          key: 'body',
          style: { flex: '1 1 auto', overflowY: 'auto', padding: 14, position: 'relative', minHeight: 0 },
        }, [
          h(active.Comp, {
            key: active.key, version: ver, onDirty: bump, toast, confirm,
            jumpToTab: (k) => setTab(k),
          }),
        ]),

        h(ConfirmModal, { key: 'modal', state: modal, onClose: closeModal }),
        // ⚠️ Toast 挂在**面板根**（不是滚动的内容区），否则会随内容滚走。
        h(ToastHost, { key: 'toast', toasts, onDismiss: dismissToasts }),
      ]);
    }

    /** 右侧边栏 tab 上的小图标（纯 SVG，跟着 currentColor 走） */
    function PanelGlyph({ size = 16 }) {
      return h('span', {
        'aria-hidden': true,
        style: {
          width: size, height: size, lineHeight: `${size}px`,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: Math.round(size * 0.92),
        },
      }, '🎯');
    }

    /** 右侧边栏 tab 的标题（图标 + 文字） */
    function TabTitle() {
      return h('span', {
        style: { display: 'inline-flex', alignItems: 'center', gap: 6 },
      }, [
        h(PanelGlyph, { key: 'i', size: 15 }),
        h('span', { key: 't' }, '职业规划'),
      ]);
    }

    /**
     * 侧边栏底部入口按钮（挂在 `sidebar.footer.action`）。
     *
     * 契约照抄 dsh-context 的同名注册：外壳把按钮渲染在侧边栏底部（设置旁边）。
     * 点击由外层传入的 onClick 处理 —— 展开右侧边栏并切到本插件的 tab。
     */
    function SidebarEntry({ onClick }) {
      return h('button', {
        type: 'button',
        title: '打开职业规划工作台',
        'aria-label': '打开职业规划工作台',
        onClick: onClick || undefined,
        style: {
          display: 'flex', alignItems: 'center', gap: 6,
          width: '100%', padding: '6px 8px', cursor: 'pointer',
          border: 'none', background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          borderRadius: 6, fontSize: T.font, textAlign: 'left',
        },
      }, [
        h('span', { key: 'i', 'aria-hidden': true }, '🎯'),
        h('span', { key: 't' }, '职业规划'),
      ]);
    }

    /** 本插件在插槽里的注册 id（外壳用它做 key，必须稳定） */
    const PANEL_ID = 'dsh-career-planner';

    /**
     * 打开右侧边栏的「职业规划」tab。
     *
     * 契约照抄 dsh-context 的 `openContextSidebar()`：
     *   `ctx.get('sidebarRight').openTab(kind)` —— 列会在同一步展开。
     * 该服务是**可选**的（老版本没有），所以每步都探测，失败返回 false
     * 让调用方保留自己的兜底行为，而不是抛错。
     */
    function openCareerSidebar(ctx) {
      try {
        const face = ctx && ctx.get ? ctx.get('sidebarRight') : null;
        if (!face || typeof face.openTab !== 'function') return false;
        face.openTab.call(face, PANEL_ID);
        return true;
      } catch { return false; }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 动画样式（需求 6）
        if (ctx.get) {
          const styles = ctx.get('styles');
          if (styles && typeof styles.insert === 'function') {
            ctx.effect(() => styles.insert(
              '@keyframes cw-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }\n'
              + '@keyframes cw-pop { from { opacity: 0; transform: scale(.98); } to { opacity: 1; transform: none; } }'
            ), 'dsh-career-planner:styles');
          }
        }

        // ═══════════════════════════════════════════════════════════════
        //  注册方式完全照抄 dsh-context（「上下文」面板），它是同一位置
        //  上已验证可用的参考实现。
        //
        //  ⚠️⚠️ 血泪教训（v1.6.0 踩过两次）：
        //   ① `register()` 的第一个参数**必须带 `name` 字段**写明目标插槽名。
        //      漏了它，外壳拿到一个没有归属的注册 → **整个页面白屏**，
        //      用户只能把插件从 package.json 删掉才恢复。
        //   ② 别用 `sidebar.panellist` + `main`。它们在 slot 目录里存在，
        //      但**没有任何已安装插件在用**，契约未经检验。
        //   ③ 接可选服务要用 `ctx.inject`（延迟注入），不要写进硬 inject ——
        //      否则老版本 Harness 上插件会一直 pending。
        // ═══════════════════════════════════════════════════════════════

        // ① 侧边栏底部的入口按钮（点它展开右侧边栏）
        //    ⚠️ register 的第二个参数必须是**组件**，不能是元素 ——
        //       写成 `() => h(Comp, ...)` 传进去的是元素，外壳渲染不了。
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: PANEL_ID,
          order: 30,
        }, () => h(SidebarEntry, { onClick: () => openCareerSidebar(ctx) })));

        // ② 右侧边栏的 tab 类型 + 内容 + 标题
        //    `sidebarRightTabs` 是**可选**服务（0.1.5 线才有），
        //    所以走延迟注入：老版本上回调不触发，插件也不会 pending。
        ctx.inject(['sidebarRightTabs'], (raw) => {
          const injected = raw || {};
          const tabs = injected.sidebarRightTabs;
          if (!tabs || typeof tabs.register !== 'function') return undefined;

          const disposers = [];
          const own = (r) => { if (typeof r === 'function') disposers.push(r); };
          try {
            // 注册 tab 类型。id 与 kind 都用 PANEL_ID（kind 是 openTab 的入参）。
            own(tabs.register({
              id: PANEL_ID,
              kind: PANEL_ID,
              title: () => '职业规划',
              guide: [{
                order: 40,
                title: () => '职业规划',
                description: () => '职业画像、投递进度、JD 池、技能与简历',
                icon: PanelGlyph,
              }],
            }));

            // tab 内容
            own(injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register({
              name: 'sidebar.right.pane.tab',
              key: PANEL_ID,
            }, Workbench)));

            // tab 标题（带图标）
            own(injected.slots.inject('sidebar.right.pane.tab.title', () => injected.slots.register({
              name: 'sidebar.right.pane.tab.title',
              key: PANEL_ID,
            }, TabTitle)));
          } catch {
            // 注册失败（id 被占 / 注册表是恶意的）→ 撤销已完成的，
            // 让侧边栏少一个 tab，而不是把整个浏览器拖垮
            for (const d of disposers) { try { d(); } catch { /* 忽略 */ } }
            return undefined;
          }
          return () => { for (const d of disposers) { try { d(); } catch { /* 忽略 */ } } };
        });
      },
    };
  },
});

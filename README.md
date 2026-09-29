# dsh-career-planner

一套装在 **DeepSeek Harness (DSH)** 里的求职管理工具。**装一个插件即可**——预设随插件包分发，插件启动时自动同步到 DSH。

| 组成 | 是什么 | 去哪 |
|---|---|---|
| **工作台插件** | 右侧边栏「职业规划」面板（画像 / JD 池 / 投递 / 技能 / 简历） | profile 的 `node_modules/` |
| **职业规划师预设** | AI 的人格、工具与 8 个技能手册，**随插件包自动同步** | 自动同步到 `~/.dsh/.agent-presets/` |
| **数据层工具** | `career_read` / `career_write`，让 AI 读写职业数据 | 随预设分发 |

## 安装（一条命令）

```bash
dsh plugin --profile web add dsh-career-planner@latest
```

装完**重启 DSH**即可。插件启动时会：

1. 把包内 `presets/career-planner/` 同步到 `~/.dsh/.agent-presets/`（幂等，只覆盖自己的预设）；
2. 把包内 `store/` 的位置广播给预设工具（`CAREER_STORE_DIR`）。

然后新建会话，在预设选择器里选「**职业规划师**」，右侧边栏出现「职业规划」面板。

> 从源码 / Git 安装：`dsh plugin --profile web add <git 地址或本地路径>`

## 核心设计

### 代码跟插件走，数据留用户目录

它没有传统的前端/后端分离。**界面和 AI 读写的是同一份文件、同一套规则**：

```
你跟 AI 说话 ──→ career_write ──┐
                                ├──→ career-store.mjs ──→ <工作区>/career/*.json
你点界面     ──→ HTTP API ──────┘
```

数据层代码（`store/*.mjs`）**只在插件包里，不复制到工作区**。界面（`index.js`）与
AI 工具（`career-data-tools.js`）都从插件包加载**同一份代码**，因此共用同一条模块
实例 —— 状态机、去重、审计、以及模块级词表缓存只有一份，界面与 AI 天然一致。

```
插件包 <profile>/node_modules/dsh-career-planner/
├── index.js  client.js  preset-sync.mjs
├── store/                      ← 数据层代码（唯一一份）
│   └── career-store.mjs  tech-taxonomy.mjs  resume-parse.mjs
└── presets/
    └── career-planner/         ← 预设（启动时同步到 ~/.dsh/.agent-presets/）
        ├── agent.cordis.yml  preset.yml
        ├── tools/career-data-tools.js
        └── skills/             （8 个技能手册）

用户工作区/
└── career/                     ← 只有数据，首次运行自动建骨架
    ├── jobs/ profile/ skills/ ...
```

> **AI 工具怎么找到数据层代码**：预设被同步到 `<DSH_HOME>/.agent-presets/`，插件包在
> `<DSH_HOME>/profiles/<profile>/node_modules/`，两者是平行分支，裸模块名解析不到。
> 所以插件启动时把包内 `store/` 的绝对路径写进环境变量 `CAREER_STORE_DIR`，预设工具
> 从它加载。**这意味着插件必须启用**；未启用时 AI 工具会给出明确报错。

### 预设为什么能自动安装

DSH 的 agent 预设只从 `<DSH_HOME>/.agent-presets/` 发现。本插件把预设打包在
`presets/` 里，启动时同步过去（参照 `@linxin666/dsh-liangshen` 的做法）。

同步规则：

- **幂等**：目标与源逐字节一致就跳过；
- **只动自己的预设**：只覆盖 `career-planner` 这一个 id，用户自己写的、别的插件
  同步进来的预设**绝不触碰**；
- **覆盖 + 清理**：同名预设按包内版本覆盖（升级插件重启即更新），包内没有的旧文件会被清掉。

## 安装（手动 / 离线）

如果不走 `dsh plugin add`，也可以手动放（**包根就是这个仓库根**）：

```bash
# 1) 把仓库内容整个放进 profile 的 node_modules
cp -r . "$DSH_HOME/profiles/web/node_modules/dsh-career-planner"
cd "$DSH_HOME/profiles/web/node_modules/dsh-career-planner" && npm install

# 2) 在 profile 的 package.json 里登记（dependencies + dsh.profile.bundles 各加一行）
#    "dsh-career-planner": "file:node_modules/dsh-career-planner"

# 3) 预设不用手动拷 —— 重启后插件会自己同步
```

> **`npm install` 装什么**：简历解析依赖 `officeparser`。不装也能跑，但简历的
> **图片 / 扫描件**解析会失败（docx / pdf 有内置零依赖兜底仍可用）。

> ⚠️ **插件与预设要一起装**。AI 工具的数据层代码由插件启动时提供（见「核心设计」），
> 只装预设不启用插件时，`career_read` / `career_write` 会报
> 「找不到职业数据层代码：环境变量 CAREER_STORE_DIR 未设置」。

### 3. 指定工作区

数据默认落在 DSH 的会话工作区下。**如果解析到的目录不对**，设一个环境变量显式指定：

```bash
# Windows PowerShell
$env:CAREER_WORKSPACE = "D:\我的职业数据"

# macOS / Linux
export CAREER_WORKSPACE=/Users/me/career-data
```

插件与预设工具都优先读它。首次运行时数据目录会自动建好骨架。

> 工作区里**只有数据，没有代码**。所以判断工作区是否选对，看的是该目录下有没有
> `career/` 数据目录，而不是有没有 `.mjs`。

### 3. 指定工作区（可选）

数据默认落在 DSH 的会话工作区下。**如果解析到的目录不对**，设一个环境变量显式指定：

```bash
# Windows PowerShell
$env:CAREER_WORKSPACE = "D:\我的职业数据"

# macOS / Linux
export CAREER_WORKSPACE=/Users/me/career-data
```

插件与预设工具都优先读它。首次运行时数据目录会自动建好骨架。

> 工作区里**只有数据，没有代码**。所以判断工作区是否选对，看的是该目录下有没有
> `career/` 数据目录，而不是有没有 `.mjs`。

## 目录结构

> **包根 = 仓库根。** `package.json` 必须在根目录，`dsh plugin add` 才能识别为插件包。

```
dsh-career-planner/                 # ← npm/git 包根 = 仓库根
├── package.json                    # ★ 含 dsh.bundle.patch + dsh.client（必须在根）
├── index.js                        # Host 半边：HTTP 路由、工作区解析、广播 store 路径、同步预设
├── client.js                       # Client 半边：右侧边栏面板的 5 个 Tab
├── preset-sync.mjs                 # 把包内 presets/ 同步到 <DSH_HOME>/.agent-presets/
├── cordis.patch.yml                # 插件挂载补丁
├── store/                          # ★ 数据层代码（唯一一份，界面与 AI 共用）
│   ├── career-store.mjs            # 所有业务规则：状态机、去重、排期、审计、打标、图谱
│   ├── tech-taxonomy.mjs           # 技术词表：同义词归并、配色
│   └── resume-parse.mjs            # 简历 → Markdown（officeparser 主力 + 零依赖兜底）
├── presets/                        # ★ 预设（随包分发，启动时自动同步）
│   └── career-planner/
│       ├── agent.cordis.yml        # AI 人格 + 加载哪些工具/技能
│       ├── preset.yml              # 显示名「职业规划师」与描述
│       ├── tools/
│       │   └── career-data-tools.js   # career_read / career_write
│       └── skills/                 # 8 个技能手册
│           ├── career-profile/  jd-analysis/   jd-sourcing/   jd-tagging/
│           └── resume-review/   learning-path/ interview-experience/ direction-advice/
└── README.md  LICENSE  .gitignore
```

## 数据目录

首次运行后，工作区下会出现：

```
<工作区>/career/
├── profile/profile.json         # 职业画像标签（机读权威）
├── jobs/jobs.json               # JD 信息池
├── applications/applications.json
├── skills/skills.json
├── graph/skill-graph.json       # 技能图谱（自动生成）
├── resumes/                     # 简历原件（永不修改）
└── logs/events.jsonl            # 变更审计日志（只追加）
```

三条不可违背的规则：

1. **`*.json` 是机读权威，`*.md` 是它的投影** —— 改数据改 json。
2. **简历原件永不被修改** —— 解析结果写成新文件。
3. **审计日志只追加** —— 每条标签是谁、何时、是否经你确认都查得到。

## 四条业务铁律

1. **AI 推断的东西必须用户确认** —— `ai_inferred` / `resume_parsed` 来源的标签一律
   `confirmed: false`，不参与正式结论。
2. **技能不能直接标"已通过"** —— 必须真的通过一次考核。
3. **简历原件永不被修改。**
4. **投递状态只能前进** —— `force: true` 能跳级但不能倒退，撤销只能走 `undoApplicationStatus()`。

## 环境变量

| 变量 | 作用 |
|---|---|
| `CAREER_WORKSPACE` | 显式指定工作区根目录（**最可靠**，路径解析出错时用它） |
| `CAREER_STORE_DIR` | 插件包内 `store/` 的绝对 `file://` URL。**由插件启动时自动写入**，供预设工具加载数据层；一般不用手填 |
| `DSH_HOME` | DSH 主目录。插件据此定位 `.agent-presets/` 做预设同步；一般不用手填（默认 `~/.dsh`） |

## 排错

**症状：改了代码没生效**
数据层代码与 `index.js` 被 Node 缓存在内存里 —— 改完**必须重启 DSH**。
只改 `client.js` 刷新浏览器即可。

**症状：预设选择器里没有「职业规划师」**
插件启动时的预设同步没成功。检查：

1. `~/.dsh/.agent-presets/career-planner/agent.cordis.yml` 是否存在；
2. DSH 启动日志里有没有 `[dsh-career-planner] 预设同步` 相关告警；
3. 插件包内 `presets/career-planner/` 是否完整（`npm` 发布时若漏了 `files` 白名单就会缺）。

**症状：AI 报「找不到职业数据层代码：环境变量 CAREER_STORE_DIR 未设置」**
工作台插件没启用。预设工具的数据层代码由插件提供，两者要一起装。确认
`dsh-career-planner` 在当前 profile 的 `node_modules` 里并已启用，然后重启 DSH。

**症状：AI 报「CAREER_STORE_DIR 指向的目录里没有 career-store.mjs」**
插件包安装不完整，`store/` 目录缺文件。重装插件。

**症状：数据写到了奇怪的目录（比如桌面）**
不是数据坏了，是**工作区解析错了**。设 `CAREER_WORKSPACE` 指向真实工作区。

**症状：简历图片/扫描件解析失败**
`officeparser` 没装。进插件目录 `npm install`，或把文字复制成 `.txt` 再上传。

## License

MIT —— 见 [LICENSE](LICENSE)。

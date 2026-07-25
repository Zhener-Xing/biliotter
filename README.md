# BiliOtter

桌面学习宠物：在 B 站看知识区视频时，用像素风水獭盯专注、记笔记、出测验，并把知识库按账号隔离与云端同步。

---

## 1. 功能

### 桌面宠物

- Electron 置顶小窗，像素动画反馈学习状态（等待、观看、分心、提问、跳舞等）
- 气泡提示：插件离线、登录中、同步中、专注中断等
- 点击宠物可打开笔记 / 知识库首页

### B 站学习桥（浏览器扩展）

- 记录视频观看进度与字幕
- 检测切页、失焦、换 BV 等专注中断，实时同步给桌面端
- 探测 B 站登录态，把账号与 Cookie 经本机桥传给 Electron
- 桌面端可通过桥向扩展下发指令（如配合学习流程）

### 知识库与笔记

- 康奈尔笔记：按视频整理，支持用户编辑与 AI 协作整理
- 课程组 / 文件夹组织笔记与学习内容
- 课程思维导图（Markmap）
- 本地 SQLite 存储；笔记截图等资源通过自定义协议 `bilinotes://` 加载

### 本地切块检索（RAG）

聊天等问答**不把整库笔记塞进模型**，而是先在本机做检索，再把命中摘录作为上下文（简易 RAG，目前**无向量 / embedding**，走关键词全文检索）。

**写入时切块**

- 保存笔记后，按 Markdown 一～三级标题分段，过长段落再按约 **450 字**切分（重叠约 **60 字**）
- 切块写入 `note_chunks`，并同步进 SQLite **FTS5** 虚表 `note_chunks_fts`（优先 `trigram` 分词，不可用则回退默认分词）

**检索时**

- 从用户问题里抽关键词，对 FTS5 做 `MATCH`，按 **bm25** 排序取 Top-K
- 短查询或 FTS 无结果时，回退 `LIKE` 模糊匹配
- 可限定单视频 `bvid`、多 `bvids`，或全库检索

**聊天里怎么用**

1. 优先在**当前正在看的视频**笔记里检索  
2. 不足再扩到**全库**（合计约 5 条摘录）  
3. 若在问「这个视频在讲什么」等且无命中，会摘一段当前笔记正文兜底  
4. 问「有哪些笔记 / 最近记了什么」等元问题时，附带笔记目录（必要时再附最近一篇摘录）  
5. 检索结果作为第二条 system 消息注入；要求**只依据摘录回答知识库问题**，不够则说「我不知道」，并返回 `sources`（bvid / 标题 / chunk 下标）供对照

测验 Skill 出题时也会用笔记内容，但更偏向康奈尔「要点 + 总结」等高密度段落，而不是整段 FTS 长摘录。

### AI 助手（Skills）

聊天入口会先尝试 Skills，再落到上面的 RAG 闲聊。LLM 走可配置的 OpenAI 兼容接口（见 `.env.example`）。未配置云端时，笔记与知识库仍可纯本地使用。

#### Skill：测验（`game-quiz`）

基于你已有的笔记做**选择题小游戏**，桌宠会进入答题相关动画（如跳舞）。

| 项 | 说明 |
|----|------|
| 入口 | 聊天里输入 `/game`，或 `/game 考一下某某` |
| 选范围 | 课程组、课程组/文件夹、当前视频、主题关键词（主题走笔记检索） |
| 出题语料 | 优先笔记里的「要点 / 总结」等结构化内容，控制 token，避免整库灌入 |
| 玩法 | 多选题；默认 **3 条命**；可边答边补题；点选项或输入 A/B/C/D |
| 退出 | macOS：`⌘S+G` 中途退出；结束后可再 `/game` 开新局 |
| 多义消歧 | 匹配到多个课程组时，会先让你选一个再开考 |

典型流程：`/game` → 说「操作系统课程组」或一个主题 → 确认范围 → 自动出题 → 作答直到通关或生命耗尽。

#### Skill：学习计划（`learning-plan`）

帮你把「想学什么」落成知识库里的**课程组结构**，并顺手把视频丢进 B 站稍后再看 / 收藏。

| 命令 / 说法 | 作用 |
|-------------|------|
| `/plan` 或 `/plan 我想学…` | 用 LLM 生成课程体系预览（课程组名 + 若干文件夹） |
| 预览阶段回复「确认」等 | 真正创建课程组与文件夹；也可改需求让模型重出一版；「取消」放弃 |
| `/watchlater` 或自然语言「加入稍后再看」 | 把当前视频 / 消息里的 BV /「最近看的」加入稍后再看 |
| `/fav`、`/favorite` 或「加入收藏」 | 同上，写入默认收藏 |

补充约定：

- 预览确认有时效（约 10 分钟），过期需重新 `/plan`
- 写 B 站稍后再看/收藏时，优先走扩展代发；需已登录且插件在线
- 与测验互斥：开 `/game` 时会重置进行中的 plan 会话

### 云端同步（可选）

- 用 B 站登录态换 JWT，按账号同步知识库变更
- 支持 revision / 增量 pull、push pending、退出前 flush

---

## 2. 技术栈

| 层级 | 技术 |
|------|------|
| 桌面端 | Electron（主进程 CommonJS）、本地 HTTP Bridge（`127.0.0.1:39261`） |
| 浏览器 | Chrome Manifest V3 扩展（service worker + content scripts） |
| 本地数据 | Node 内置 `node:sqlite`、按 uid 分库、笔记资源目录 |
| 本地 RAG | Markdown 切块 + SQLite **FTS5**（bm25；无向量库） |
| AI | 可配置 LLM API（如 DeepSeek）、任务化 system prompt（`prompts/`）、Skills（`skills/`） |
| 云端 API | Node.js + Express、JWT、MySQL（`cloud-api/`） |
| 前端页面 | 原生 HTML/CSS/JS；笔记侧 KaTeX / marked；导图 Markmap / D3 |

**仓库结构（简要）**

```
bili-pet/
├── canva.js                 # Electron 主进程入口
├── paths.js                 # 开发/打包后的数据目录解析
├── scripts/pack-*.js        # npm run pack → dist/
├── face.html / renderer.js  # 桌宠窗口
├── bridge-server.js         # 扩展 ↔ 桌面 本机桥
├── notes-db.js              # 本地知识库
├── cloud-sync.js            # 云同步客户端
├── account-bind.js          # 账号绑定状态
├── skills/                  # 测验、学习计划等 Skill
├── prompts/                 # LLM 系统提示词
├── chat/                    # 聊天窗
├── note_cornell/            # 康奈尔笔记页
├── launcher/                # 知识库首页（含本地 server）
├── internet_extension/      # Bili Pet Bridge 扩展
└── cloud-api/               # 鉴权 + 知识库同步服务
```

详细安装见下一节。

---

## 3. 如何安装

当前以**源码 + npm**方式运行（Electron 桌宠 + Chrome/Edge 扩展）。三端共用同一套仓库，差异主要在 Node 架构与终端命令。

### 共同准备

1. 安装 **[Git](https://git-scm.com/)**  
2. 安装 **Node.js LTS（建议 22+）**（用于 `npm install`；应用实际跑在 Electron 自带的 Node 上，已含 `node:sqlite`）  
3. 安装 **Google Chrome** 或 **Microsoft Edge**（用于加载扩展；需能登录 bilibili.com）  
4. 克隆并进入仓库：

```bash
git clone https://github.com/Zhener-Xing/biliotter biliotter
cd biliotter
```

5. 配置环境变量（三端都要做）：

```bash
# macOS / Linux
cp .env.example .env
```

用编辑器打开 `.env`，至少填写：

- `LLM_API_KEY`，填写你自己的API KEY
- 若使用云同步：`CLOUD_API_BASE=https://你的云端地址`（不填则纯本地）

6. 安装依赖并启动桌宠：

```bash
npm install
npm start
```

7. 加载浏览器扩展（Chrome / Edge 步骤相同）：

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 打开右上角「开发者模式」
3. 「加载已解压的扩展程序」→ 选择仓库里的 **`internet_extension/`** 文件夹
4. 打开 [bilibili.com](https://www.bilibili.com) 并登录；保持扩展启用，桌宠会通过本机桥 `127.0.0.1:39261` 连通

（可选）自建云 API：`npm run cloud-api:install` → 配置 `cloud-api/.env` → `npm run cloud-api`。

---

### Apple Silicon（M 系列，arm64）

1. 确认芯片与终端架构（应看到 `arm64`）：

```bash
uname -m
# 期望输出：arm64
```

2. 安装 **arm64 版** Node.js LTS（官网 macOS ARM64 安装包，或 Homebrew）：

```bash
# Homebrew（Apple Silicon 默认前缀 /opt/homebrew）
brew install node
node -p "process.arch"
# 期望输出：arm64
```

3. 按上文「共同准备」克隆、写 `.env`、`npm install`、`npm start`。  
   `npm install` 会拉取 **darwin-arm64** 的 Electron，一般无需额外参数。

4. **注意**：若终端跑在 Rosetta（`uname -m` 为 `x86_64`），请改用原生 arm64 终端，或避免混用 x64 Node 与 arm64 Electron，以免依赖架构不一致。

5. 首次从未知开发者运行若被拦截：系统设置 → 隐私与安全性 → 仍要打开；或在应用上右键「打开」。

---

### Intel Mac（x86_64）

1. 确认架构：

```bash
uname -m
# 期望输出：x86_64
```

2. 安装 **x64 / Intel** 版 Node.js LTS（官网 macOS x64 安装包，或 Intel Homebrew `/usr/local`）：

```bash
brew install node
node -p "process.arch"
# 期望输出：x64
```

3. 同样执行：克隆 → `.env` → `npm install` → `npm start`。  
   会安装 **darwin-x64** Electron。

4. 扩展加载方式与 Apple Silicon 相同（Chrome / Edge → 开发者模式 → 选 `internet_extension/`）。

---

### Windows（x64）

1. 安装：
   - [Node.js LTS Windows Installer (x64)](https://nodejs.org/)（勾选将 Node 加入 PATH）
   - [Git for Windows](https://git-scm.com/download/win)
   - Chrome 或 Edge

2. 用 **PowerShell** 或 **「Git Bash」** 打开，确认架构与 Node：

```powershell
node -p "process.arch"
# 常见输出：x64
```

3. 克隆并配置：

```powershell
git clone https://github.com/Zhener-Xing/biliotter biliotter
cd biliotter
copy .env.example .env
```

（Git Bash 下可用 `cp .env.example .env`。）编辑 `.env` 填入 `LLM_*` 等。

4. 安装并启动：

```powershell
npm install
npm start
```

会下载 **win32-x64** Electron。若 SmartScreen 提示未知应用，选择仍要运行。

5. 加载扩展：Chrome 打开 `chrome://extensions`（或 Edge：`edge://extensions`）→ 开发者模式 → 加载已解压扩展 → 选本仓库的 `internet_extension` 文件夹。

6. **防火墙**：首次运行若弹出网络访问提示，请允许 Node/Electron 访问**专用网络**（桥只监听本机 `127.0.0.1`，用于扩展通信）。

7. 路径：尽量把仓库放在无特殊权限的目录（如 `%USERPROFILE%\Documents\bili-pet`）；避免仅用管理员权限运行导致扩展与桌宠用户态不一致。

---

### 装好后怎么确认

| 检查项 | 期望 |
|--------|------|
| `npm start` | 出现桌宠小窗 |
| 扩展图标 / Popup | 显示与桌宠桥连通（非长期离线） |
| 已登录 B 站 | 宠物侧完成账号绑定；需要时出现同步提示 |
| 聊天 / 笔记 | 门禁通过后可打开；未配 LLM Key 则 AI 能力不可用 |

常见问题：扩展显示离线 → 先确认桌宠已启动；换号后笔记「消失」→ 见「一人一獭」（旧号本地已 purge，需同一账号从云端拉回）。

---

## 4. 打包分发

在仓库根目录：

```bash
npm install
npm run pack
```

会在 `dist/` 产出：

| 产物 | 用途 |
|------|------|
| `bili-pet-bridge.zip` | 解压后用 Chrome/Edge「加载已解压的扩展程序」 |
| `BiliOtter-<platform>-<arch>/` | 当前系统可运行的桌宠目录（macOS 含 `BiliOtter.app`） |
| `BiliOtter-win32-x64.zip` | **Windows 分发包**（内含 `BiliOtter.exe`，需 `npm run pack:win`） |

**Windows 包（可在 Mac 上交叉打包）：**

```bash
npm run pack:win
# 或镜像加速（国内）：
# ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run pack:win
```

产物：`dist/BiliOtter-win32-x64.zip` → 解压后运行 `BiliOtter.exe`。

**收件人三步：**

1. 打开桌宠（macOS：`BiliOtter.app`；Windows：解压 zip 后运行 `BiliOtter.exe`）
2. 解压 `bili-pet-bridge.zip` → 浏览器扩展指向该文件夹  
   （桌宠包内也有一份：macOS 多为 `BiliOtter.app/Contents/Resources/bili-pet-bridge`；Windows 在 `resources/bili-pet-bridge`）
3. 编辑桌宠数据目录里的 `.env`，填入 `LLM_API_KEY`（首次启动会从示例复制一份）  
   - macOS：`~/Library/Application Support/BiliOtter/.env`  
   - Windows：`%APPDATA%\BiliOtter\.env`

只打扩展：`npm run pack:ext`。只打本机桌宠：`npm run pack:app`。扩展 + 本机 + Windows：`npm run pack:all`。

开发时仍用 `npm start`；运行时数据仍写在仓库根目录。只有**打包后的应用**才写入系统 userData。

> 当前为未签名包：macOS 可能需「右键 → 打开」或在「隐私与安全性」里允许；Windows 可能被 SmartScreen 拦截，选仍要运行即可。

---

## 5. 「一人一獭」

**一人一獭** = **一个 B 站账号，对应一份独立的本地獭窝（知识库），账号切换或退出时先上传再清空本机，避免串号、串笔记。**

### 为什么需要

同一台电脑上可能换号登录 B 站。若不隔离，上一个账号的笔记、课程组、同步 token 会留在磁盘上，下一个用户打开宠物就能看到——这对学习记录属于敏感数据。

### 怎么做的

1. **绑定**  
   扩展检测到已登录的 B 站 `uid` 后，桌面端将其记为当前绑定账号（`activeUid` / `boundUid`），并挂载该账号的本地库。

2. **分库**  
   本地 SQLite 按账号拆分，例如：  
   `.bili-pet-notes-<uid>.db`  
   云端 JWT 也按 uid 落盘，互不混用。

3. **门禁**  
   扩展在线 + 会话已登录 + 当前 uid 已挂载 +（云端开启时）首拉门闩就绪后，才开放笔记 / 同步等操作（`session-gate`）。未就绪时宠物会用气泡提示原因。

4. **换号 / 退出：flush → purge**  
   - 检测到 **账号切换** 或 **退出** 时：先把该 uid 的 pending 变更尽量推到云端，再 **删除本机该 uid 的库与相关本地态**。  
   - 新 uid 要等旧仓清理完成后才 `commitBinding`，避免短暂窗口里读写错库。  
   - 清理失败会后台重试，避免「以为清了其实还在」。

5. **再登录**  
   同一账号再次登录时，可从云端 pull 回知识库；本机重新形成「这一只獭」的本地窝。

### 一句话

> 獭跟着 B 站账号走：人换了，本机窝清掉；人回来，再从云端认领自己的那一份。

这样桌宠可以多人轮流用同一台机器，而不把别人的学习记录留在本地。

---

## 6. 怎么保障数据安全

学习笔记、课程结构、专注统计都按账号隔离；换号时优先「先保全、再清空」，避免串号泄露或误删。

### 账号与本地隔离

| 措施 | 作用 |
|------|------|
| **按 uid 分库** | 每个 B 站账号独立 SQLite（及对应 JWT 文件），不混写 |
| **会话门禁** | 扩展在线 + 已登录 + 正确挂载库（云端开启时还要等首拉就绪）后，才开放笔记 / 聊天 / 同步 |
| **异账号 purge 闩** | 后台清理旧号库时标记 `foreignPurge`，避免短暂读写到别人的库 |
| **操作串行化** | 绑定 / 换号 / 退出走同一条账号操作链，降低并发踩踏 |

### 换号 / 退出：先上传，再删除（云端开启时）

原则是 **数据安全优先：推不上去就不删本地**。

1. 检测到退出或换号 → 挂起旧账号的本地库  
2. 用该 uid 的云端 token 把 pending 变更 **flush（push）** 到服务器  
3. 确认无残留 pending 后，才 **purge**：删除 `.bili-pet-notes-<uid>.db`（含 WAL/SHM）、相关笔记资源、该 uid 的 token 文件  
4. 若 push 失败或仍有 pending → **不删库**，后台静默重试，并提示「清理被拦截」  
5. 新账号要等旧仓处理完才 `commitBinding`，减少「人已换、库还是旧的」窗口  

未配置 `CLOUD_API_BASE`（纯本地）时，不会走「上传后删盘」这条链路，数据留在本机分库里；门禁仍会阻止未登录态随便读写。

### 云端鉴权与租户隔离

- **换票**：用浏览器里的 B 站 Cookie 调 `api.bilibili.com` 校验真实 `mid`，通过后才签发 **JWT**（payload 含 `uid`）  
- **后续请求**：知识库 pull / push 只带 `Authorization: Bearer …`，服务端按 JWT 里的 `uid` 过滤行（`WHERE uid = …`），账号之间数据不串  
- Cookie 主要用于登录鉴权与部分 B 站写操作；日常同步凭据是 JWT，并按 uid 分文件存放  

### 本机通信边界

- 桌面 ↔ 扩展的桥只监听 **`127.0.0.1`**，默认不对外网暴露  
- 敏感能力（笔记读写、同步、Skills）都挂在「当前绑定账号 + 门禁」之后，而不是裸接口任意访问  

### 使用与部署上建议自查

- 生产环境务必设置强随机 **`JWT_SECRET`**，不要用示例默认值  
- 云 API 前面建议 Nginx / HTTPS，并收紧监听地址（勿长期把调试用的 `0.0.0.0` 直接暴露公网）  
- 本地库与 Cookie 仍落在本机磁盘；请保护好自己的用户账号与系统登录态（本项目不做全盘加密）  


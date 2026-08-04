# BiliOtter

在 B 站学习时用的桌面小水獭：盯专注、记笔记、出测验、课程组与思维导图；按账号隔离知识库并可云端同步；支持好友摸獭与笔记互传。

| 你是谁 | 看哪里 |
|--------|--------|
| **普通用户（安装 / 使用）** | [`BiliOtter使用与安装指南.md`](./BiliOtter使用与安装指南.md) |
| **开发者 / 自建部署** | 本文 |

仓库：<https://github.com/Zhener-Xing/biliotter>

---

## BiliOtter 1.10 更新内容

- **多分 P / 选集分别记笔记**：同一 BV 下切换选集（`?p=`）会结束旧会话并新开一篇；P1 仍用裸 `BVxxx`（兼容旧笔记），P2 起为 `BVxxx#p2`…；标题可带 `· P2 分P名`
- **笔记标题可改**：跟播笔记窗顶部标题可直接编辑，自动保存；改过后不会被视频原标题盖回。知识库编辑页原本已支持改标题
- **本地知识库永久保留**：退出 / 换号只推云端并卸挂载，**不再删除**本机 `.bili-pet-notes-<uid>.db`；同号下次可秒开
- **账号隔离照旧**：未登录或登录其他 B 站账号时，App 内访问不到另一账号知识库（一账号一库挂载）；本机磁盘文件按 uid 分文件保留

> 使用多分 P 记笔记前，请重新加载浏览器扩展（bridge ≥ 0.2.16）并重启桌宠。

---

## 功能一览

- **桌宠**：置顶像素动画；单击开当前视频笔记，双击开知识库，右键开好友
- **浏览器扩展**：观看进度 / 字幕、专注中断检测、B 站登录态桥接（本机 `127.0.0.1:39261`）；同分多 P 按选集开笔记
- **笔记**：康奈尔笔记、一键整理、截图、**可改标题**；本地 SQLite（按 uid 分库）
- **课程组**：文件夹、思维导图（按知识模块生成，尽量去掉视频标题 / BV 印记）
- **聊天**：本机 FTS 检索后再问 AI；Skills：`/plan`、`/game`、稍后再看 / 收藏
- **云端**（可选）：知识库同步、好友、摸獭、笔记分享；**LLM 默认走云端代理**（厂商 API Key 只放服务器）

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面 | Electron（入口 `canva.js`） |
| 扩展 | Chrome MV3（`internet_extension/`） |
| 本机桥 | `bridge-server.js` → `127.0.0.1:39261` |
| 本地库 | `node:sqlite` + FTS5 切块检索（无向量） |
| AI | OpenAI 兼容 API；客户端经 `CLOUD_API_BASE/llm/chat/completions` 代理 |
| 云端 | `cloud-api/`：Express + JWT + MySQL |
| 打包 | `npm run pack` → Mac / Windows 两个 zip（含指南与扩展） |

```
bili-pet/
├── canva.js / paths.js / preload.js
├── notes-db.js / cloud-sync.js / llm.js / quiz-pregen.js
├── skills/  prompts/  chat/  friends/  note_cornell/  launcher/
├── internet_extension/
├── cloud-api/                 # 鉴权、KB、好友、LLM 代理
├── scripts/                   # start / pack
└── BiliOtter使用与安装指南.md
```

---

## 开发环境启动

### 要求

- Node.js LTS（建议 22+）
- Git
- Chrome 或 Edge（加载扩展并登录 bilibili.com）

### 步骤

```bash
git clone https://github.com/Zhener-Xing/biliotter biliotter
cd biliotter
cp .env.example .env
npm install
npm start
```

扩展：`chrome://extensions`（或 `edge://extensions`）→ 开发者模式 → 加载已解压扩展 → 选仓库内 **`internet_extension/`** → 打开 B 站并登录。

### 桌宠 `.env`（开发）

| 变量 | 说明 |
|------|------|
| `CLOUD_API_BASE` | 云端 API 根地址；分发/联调必填 |
| `LLM_USE_CLOUD_PROXY` | 默认 `true`：AI 走云端代理 |
| `LLM_API_KEY` | **分发请留空**；仅本地直连调试时填写 |
| `LLM_DIRECT` | `true` 时强制本机直连厂商（需本地 Key） |
| `CLOUD_DEVICE_SECRET` | 与服务器 `DEVICE_AUTH_SECRET` 一致时可走设备鉴权 |
| `QUIZ_PREGEN_ENABLED` | 笔记成熟后后台预生成 `/game` 题库 |

开发若要直连模型：`.env` 设 `LLM_DIRECT=true` 并填写自己的 `LLM_API_KEY`。

### 快捷键（聊天 / 答题）

| 动作 | macOS | Windows |
|------|-------|---------|
| 打开聊天 | `⌘X` 再 `⌘O` | `Ctrl+X` 再 `Ctrl+O` |
| 中途退出答题 | `⌘S` 再 `⌘G` | `Ctrl+S` 再 `Ctrl+G` |

### 自检

| 检查 | 期望 |
|------|------|
| `npm start` | 出现桌宠 |
| 扩展 | 与桌宠桥连通 |
| B 站已登录 | 账号绑定 / 同步提示正常 |
| AI | 已登录且云端代理可用；或本地 `LLM_DIRECT` + Key |

---

## 云端 API（`cloud-api/`）

```bash
cd cloud-api
cp .env.example .env   # 填写 MySQL、JWT_SECRET、LLM_* 等
npm install
npm start              # 或仓库根目录：npm run cloud-api
```

服务器 `.env` 至少需要：

```bash
JWT_SECRET=…                 # 长随机串
MYSQL_* =…
DEVICE_AUTH_SECRET=…         # 与桌宠 CLOUD_DEVICE_SECRET 一致（可选）
LLM_API_BASE=https://api.deepseek.com
LLM_API_KEY=…                # 厂商 Key，只放服务器
LLM_MODEL=…
```

健康检查：

```bash
curl http://127.0.0.1:8787/health
# 应含 "llmProxy": true（表示已配置 LLM_API_KEY 且路由已加载）
```

主要路由：

- `POST /auth/bili`、`POST /auth/device`
- `GET/POST /kb/*`
- `/friends/*`
- **`POST /llm/chat/completions`**（需 JWT；服务器持 Key 转发厂商）

部署注意：若目录不是 git 仓库，用 `scp` 更新 `src/llm-proxy.js` 与 `src/index.js` 后 `pm2 restart`。

---

## 打包分发

在仓库根目录（建议在 Mac 上一次打出两端）：

```bash
npm install
npm run pack
```

| 产物 | 用途 |
|------|------|
| `dist/BiliOtter-macOS-<arch>.zip` | 发给 Mac 用户 |
| `dist/BiliOtter-Windows-x64.zip` | 发给 Windows 用户 |
| `dist/bili-pet-bridge.zip` | 单独扩展（两端安装包内已各有一份） |

每个用户 zip 内含：桌宠、`bili-pet-bridge.zip`、`BiliOtter使用与安装指南.md`、`请先读我.txt`。

```bash
npm run pack:mac                          # 只打当前 Mac
npm run pack:ext && npm run pack:win      # 只打 Windows
# 国内加速下载 Electron：
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run pack:win
```

未签名：Mac 需右键打开；Windows 可能需「仍要运行」。

**分发安全：** 客户端不要带真实 `LLM_API_KEY`；Key 只在 `cloud-api/.env`。打包脚本会跳过本机 `.env`。

---

## 「一人一獭」（账号隔离）

一个 B 站账号对应一份本地知识库（`.bili-pet-notes-<uid>.db`）。

- **门禁**：扩展在线 + 已登录 + 挂载正确 uid（云端开启时还要等同步就绪）后才开放笔记 / AI / 同步
- **换号 / 退出**：尽量先 push，再卸挂载；**永久不删本地库**，下次同号可秒开，后台再增量 pull
- **云端**：JWT 按 uid 隔离；好友分享仅限好友关系

> 獭跟着账号走：人换了只卸挂载，窝（本地库）还在；人回来本地秒开，再和云端对齐。

---

## 安全说明（简）

| 项 | 现状 |
|----|------|
| LLM Key | 分发版走云端代理，客户端不内置厂商 Key |
| 本机桥 | 仅 `127.0.0.1`，不对外网暴露 |
| 本地库 | 明文 SQLite；靠系统账号与分库隔离，无全盘加密 |
| 设备鉴权 | `CLOUD_DEVICE_SECRET` 便于测试分发；生产应换强随机串 |
| Demo | 云 API 若公网直暴露，请自行加防火墙 / 反代 |

本地笔记与 Cookie 仍落在本机；请保护系统登录态与 B 站账号。水獭素材有版权，部分音频不可商用。

---

## 常用脚本

| 命令 | 作用 |
|------|------|
| `npm start` | 启动桌宠（开发） |
| `npm test` | 本地同步相关校验 |
| `npm run pack` | 扩展 + Mac + Windows 安装包 |
| `npm run cloud-api` | 启动云端 API |
| `npm run cloud-api:install` | 安装 cloud-api 依赖 |

---

## 许可证与致谢

ISC。B 站为第三方平台；本项目为学习向 demo，请遵守相关服务条款与版权要求。

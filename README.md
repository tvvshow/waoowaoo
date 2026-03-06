
<p align="center">
  <img src="public/banner.png" alt="waoowaoo" width="600">
</p>

<p align="center">
  <a href="#-quick-start">English</a> | <a href="#-快速开始">中文</a>
</p>

# waoowaoo AI 影视 Studio
[![Repo](https://img.shields.io/badge/repo-tvvshow%2Fwaoowaoo-blue)](https://github.com/tvvshow/waoowaoo)
>[!IMPORTANT]
>⚠️ **测试版声明**：本项目目前处于测试初期阶段，由于暂时只有我一个人开发，存在部分 bug 和不完善之处。我们正在快速迭代更新中，欢迎进群反馈问题和需求**请及时关注项目更新！目前更新会非常频繁，后续会增加大量新功能以及优化效果，我们的目标是成为行业最强AI工具！**！
> 
> ⚠️ **Beta Notice**: This project is currently in its early beta stage. As it is currently a solo-developed project, some bugs and imperfections are to be expected. We are iterating rapidly—please stay tuned for frequent updates! We are committed to rolling out a massive roadmap of new features and optimizations, with the ultimate goal of becoming the top-tier solution in the industry. Your feedback and feature requests are highly welcome!

<img width="1676" height="540" alt="chat" src="https://github.com/user-attachments/assets/30c6fcf6-b605-48da-a571-7b7aead3df8d" />
<img width="1676" height="540" alt="chat1" src="https://github.com/user-attachments/assets/40d583a2-223a-46d9-b96b-a966390d44f8" />

一款基于 AI 技术的短剧/漫画视频制作工具，支持从小说文本自动生成分镜、角色、场景，并制作成完整视频。

An AI-powered tool for creating short drama / comic videos — automatically generates storyboards, characters, and scenes from novel text, then assembles them into complete videos.

---

## ✨ 功能特性 / Features

| | 中文 | English |
|---|---|---|
| 🎬 | AI 剧本分析 - 自动解析小说，提取角色、场景、剧情 | AI Script Analysis - parse novels, extract characters, scenes & plot |
| 🎨 | 角色 & 场景生成 - AI 生成一致性人物和场景图片 | Character & Scene Generation - consistent AI-generated images |
| 📽️ | 分镜视频制作 - 自动生成分镜头并合成视频 | Storyboard Video - auto-generate shots and compose videos |
| 🎙️ | AI 配音 - 多角色语音合成 | AI Voiceover - multi-character voice synthesis |
| 🌐 | 多语言支持 - 中文 / 英文界面，右上角一键切换 | Bilingual UI - Chinese / English, switch in the top-right corner |

## 🚀 快速开始

**前提条件**：安装 [Docker Desktop](https://docs.docker.com/get-docker/)

```bash
git clone https://github.com/tvvshow/waoowaoo.git
cd waoowaoo
docker compose up -d
```

访问 [http://localhost:13000](http://localhost:13000) 开始使用！

> 首次启动会自动完成数据库初始化，无需任何额外配置。

> ⚠️ **如果遇到网页卡顿**：HTTP 模式下浏览器可能限制并发连接。可安装 [Caddy](https://caddyserver.com/docs/install) 启用 HTTPS：
> ```bash
> caddy run --config Caddyfile
> ```
> 然后访问 [https://localhost:1443](https://localhost:1443)

### 🔄 更新到最新版本

```bash
git pull
docker compose down && docker compose up -d --build
```

### ✅ 安装后最小检查清单（推荐）

```bash
docker compose ps
docker compose logs --tail=100 app
```

确认以下条件后再开始业务操作：

- 页面可访问：`http://localhost:13000`
- 队列面板可访问：`http://localhost:13010/admin/queues`
- MySQL 健康状态为 `healthy`
- Redis 健康状态为 `healthy`

---

## 🚀 Quick Start

**Prerequisites**: Install [Docker Desktop](https://docs.docker.com/get-docker/)

```bash
git clone https://github.com/tvvshow/waoowaoo.git
cd waoowaoo
docker compose up -d
```

Visit [http://localhost:13000](http://localhost:13000) to get started!

> The database is initialized automatically on first launch — no extra configuration needed.

> ⚠️ **If you experience lag**: HTTP mode may limit browser connections. Install [Caddy](https://caddyserver.com/docs/install) for HTTPS:
> ```bash
> caddy run --config Caddyfile
> ```
> Then visit [https://localhost:1443](https://localhost:1443)

### 🔄 Updating to the Latest Version

```bash
git pull
docker compose down && docker compose up -d --build
```

### ✅ Post-Install Quick Check (Recommended)

```bash
docker compose ps
docker compose logs --tail=100 app
```

Before normal usage, confirm:

- UI is reachable at `http://localhost:13000`
- Queue board is reachable at `http://localhost:13010/admin/queues`
- MySQL service is `healthy`
- Redis service is `healthy`

---

## 🧩 PM2 部署（VPS/裸机）/ PM2 Deployment (VPS/Bare Metal)

如果你不使用 `docker compose` 启动整套应用，而是希望在 VPS 上使用 PM2 托管 `Next + Worker + Watchdog + Board`，可按下列方式部署。

If you prefer PM2 process management on a VPS (instead of running the full stack via Docker Compose), follow this setup.

### 1) 前置依赖 / Prerequisites

- Node.js `>=18.18.0`（建议 Node 20 LTS）
- npm `>=9`
- MySQL（可本机服务或容器）
- Redis（可本机服务或容器）
- PM2

```bash
npm i -g pm2
```

### 2) 安装与构建 / Install and Build

```bash
git clone https://github.com/tvvshow/waoowaoo.git
cd waoowaoo
npm install
npx prisma generate
npx prisma db push
npm run build
```

### 2.5) 配置 `.env`（必需）/ Configure `.env` (Required)

`start:worker`、`start:watchdog`、`start:board` 都会读取项目根目录 `.env`，请至少配置以下变量：

```bash
DATABASE_URL="mysql://root:your_password@127.0.0.1:3306/waoowaoo"
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
NEXTAUTH_URL="http://127.0.0.1:3000"
NEXTAUTH_SECRET="replace_with_random_secret"
CRON_SECRET="replace_with_random_secret"
INTERNAL_TASK_TOKEN="replace_with_random_secret"
API_ENCRYPTION_KEY="replace_with_32_char_hex"
STORAGE_TYPE=local
```

如果你的 MySQL/Redis 运行在 Docker 中并映射了端口，请改为对应的宿主机端口（例如 `13306`、`16379`）。

If your MySQL/Redis are running in Docker with host port mappings, use those mapped ports instead (for example, `13306` and `16379`).

### 3) 启动 4 个核心进程 / Start 4 Core Processes

```bash
pm2 start "npm run start:next" --name waoowaoo-next
pm2 start "npm run start:worker" --name waoowaoo-worker
pm2 start "npm run start:watchdog" --name waoowaoo-watchdog
pm2 start "npm run start:board" --name waoowaoo-board
pm2 save
```

### 4) 设置开机自启 / Enable Auto-Startup

```bash
pm2 startup
# 按终端提示执行返回的 sudo 命令
pm2 save
```

### 5) 常用运维命令 / Common Ops Commands

```bash
pm2 list
pm2 logs waoowaoo-worker --lines 200
pm2 restart waoowaoo-worker
pm2 restart waoowaoo-next
```

> 说明 / Note:
> - `start:next` 对应 Web/API 服务；
> - `start:worker` 对应异步图像/视频/语音任务执行；
> - `start:watchdog` 负责任务巡检与补偿；
> - `start:board` 提供队列可视化面板。

## 🏗️ 部署架构图 / Deployment Architecture

```mermaid
flowchart LR
    U[Browser / Client] --> RP[Reverse Proxy<br/>Caddy / Nginx]
    RP --> NEXT[waoowaoo-next<br/>Next.js Web + API]

    NEXT --> DB[(MySQL)]
    NEXT --> REDIS[(Redis)]
    NEXT --> Q[BullMQ Queue]

    Q --> WORKER[waoowaoo-worker<br/>Image / Video / Voice Jobs]
    WORKER --> DB
    WORKER --> REDIS
    WORKER --> MEDIA[(Local Storage / COS)]

    WATCHDOG[waoowaoo-watchdog] --> REDIS
    WATCHDOG --> DB
    WATCHDOG --> Q

    BOARD[waoowaoo-board<br/>Bull Board UI] --> REDIS
    RP --> BOARD

    WORKER --> GROK[grok-art-proxy<br/>API Integration]
    WORKER --> OTHER_AI[Other AI Providers]
```

### 架构说明（中文）

1. `waoowaoo-next` 负责前端页面与 API 入口。
2. API 把异步任务写入 BullMQ（Redis），由 `waoowaoo-worker` 消费执行。
3. `waoowaoo-worker` 负责调用外部模型服务（包括 `grok-art-proxy`）并落库/落盘。
4. `waoowaoo-watchdog` 负责超时巡检、补偿重试和异常任务回收。
5. `waoowaoo-board` 提供队列可视化界面用于排障和运维。
6. 反向代理（Caddy/Nginx）统一对外暴露 HTTPS 与路由入口。

### Notes (English)

1. `waoowaoo-next` serves both UI and API endpoints.
2. API submits async jobs to BullMQ (Redis); `waoowaoo-worker` consumes and executes them.
3. `waoowaoo-worker` calls external model services (including `grok-art-proxy`) and persists results.
4. `waoowaoo-watchdog` handles timeout checks, retry compensation, and stalled-task recovery.
5. `waoowaoo-board` exposes queue observability for operations and debugging.
6. Caddy/Nginx acts as the public HTTPS entry and reverse proxy.

---

## 🔧 API 配置 / API Configuration

启动后进入**设置中心**配置 AI 服务的 API Key，内置配置教程。

After launching, go to **Settings** to configure your AI service API keys. A built-in guide is provided.

> 💡 **推荐 / Recommended**: Tested with ByteDance Volcano Engine (Seedance, Seedream) and Google AI Studio (Banana). Text models currently require OpenRouter API.

---

## 🔌 Grok 对接说明 / Grok Integration

`waoowaoo` 与 `grok-art-proxy` 是独立项目关系：`waoowaoo` 通过 HTTP 接口调用，不直接依赖 `grok-art-proxy` 仓库内代码运行。

当前仓库版本的 Grok 图视频链路，按 `openai-compatible::*` provider 精确对接 `grok-art-proxy`（见下方致谢链接），核心规则如下：

### 中文说明（详细）

1. provider 与模型选择
- 用户在配置中心使用 `openai-compatible:<provider-id>::<model-id>` 模型键。
- `waoowaoo` 通过该 provider 的 `baseUrl + apiKey` 调用 Grok 代理。
- 图像模型使用 `grok-image*`，视频模型使用 `grok-video*`。

2. 分镜生图对接（Image）
- 主要走 `POST /api/imagine/generate`（SSE）获取图片与 `job_id`。
- 当存在参考图时可走 `POST /api/imagine/img2img`。
- 生成完成后，`waoowaoo` 会在分镜面板中持久化：
  - `grokImageUrl`（Grok 原始图 URL）
  - `grokJobId`（用于视频阶段的父任务标识）

3. 分镜生视频对接（Video）
- 走 `POST /api/video/generate`（SSE）。
- `waoowaoo` 会传入：
  - `image_url`
  - `parent_post_id`（优先使用生图阶段保存的 `grokJobId` / `grokImageUrl` 解析结果）
  - `aspect_ratio`、`video_length`、`resolution` 等参数
- 当 SSE 返回 `complete` 事件后提取视频地址并入库。

4. 本次稳定性修正（waoowaoo 侧）
- 保持 `waoowaoo -> grok-art-proxy` 的接口契约不变，仅在 `waoowaoo` 内进行调用参数与提示词策略修正。
- 对 `grok-image*` 分镜生图采用更紧凑的视觉提示词，避免将长段文本渲染为画面文字。
- 保留并强化 `grokImageUrl/grokJobId` 的链路传递，确保后续视频阶段可用。

5. 基于原版 `waoowaoo` 的本分支增强（摘要）
- 新增/强化 `grok-art-proxy` 图像与视频生成器适配，按 `openai-compatible::*` 严格路由。
- 视频生成改为优先对接 `/api/video/generate`（SSE），并补齐事件解析与错误抛出。
- 对 `parent_post_id` 解析策略做显式校验与兜底顺序修正，减少链路不确定性。
- 在分镜任务链路中补齐 Grok 元数据透传（`grokImageUrl`、`grokJobId`）用于视频阶段。
- 增加对应单元测试，确保面板生图与视频对接行为可回归验证。

### English Summary

`waoowaoo` integrates with `grok-art-proxy` as an external HTTP service (not as an in-repo runtime dependency).

For `openai-compatible::*` providers, the current integration in this repo:
- Uses `grok-image*` for storyboard image generation via `/api/imagine/generate` (and `/api/imagine/img2img` when references are used).
- Persists `grokImageUrl` and `grokJobId` from the image stage.
- Uses `grok-video*` for storyboard video generation via `/api/video/generate`, passing `image_url` and `parent_post_id`.
- Applies `waoowaoo`-side prompt/parameter stabilization while keeping the `grok-art-proxy` API contract unchanged.
- Includes branch-level hardening over upstream `waoowaoo`: stricter Grok routing, SSE parsing hardening, metadata propagation, and regression tests for the image→video path.

---

## 📦 技术栈 / Tech Stack

- **Framework**: Next.js 15 + React 19
- **Database**: MySQL + Prisma ORM
- **Queue**: Redis + BullMQ
- **Styling**: Tailwind CSS v4
- **Auth**: NextAuth.js

## 📦 页面功能预览 / preview
![4f7b913264f7f26438c12560340e958c67fa833a](https://github.com/user-attachments/assets/fa0e9c57-9ea0-4df3-893e-b76c4c9d304b)
![67509361cbe6809d2496a550de5733b9f99a9702](https://github.com/user-attachments/assets/f2fb6a64-5ba8-4896-a064-be0ded213e42)
![466e13c8fd1fc799d8f588c367ebfa24e1e99bf7](https://github.com/user-attachments/assets/09bbff39-e535-4c67-80a9-69421c3b05ee)
![c067c197c20b0f1de456357c49cdf0b0973c9b31](https://github.com/user-attachments/assets/688e3147-6e95-43b0-b9e7-dd9af40db8a0)


## 🤝 参与方式 / Contributing

本项目由核心团队独立维护。欢迎你通过以下方式参与：

- 🐛 提交 [Issue](https://github.com/tvvshow/waoowaoo/issues) 反馈 Bug
- 💡 提交 [Issue](https://github.com/tvvshow/waoowaoo/issues) 提出功能建议
- 🔧 提交 Pull Request 供参考 — 我们会认真审阅每一个 PR 的思路，但最终由团队自行实现修复，不会直接合并外部 PR

This project is maintained by the core team. You're welcome to contribute by:

- 🐛 Filing [Issues](https://github.com/tvvshow/waoowaoo/issues) — report bugs
- 💡 Filing [Issues](https://github.com/tvvshow/waoowaoo/issues) — propose features
- 🔧 Submitting Pull Requests as references — we review every PR carefully for ideas, but the team implements fixes internally rather than merging external PRs directly

---

## 🙏 致谢 / Acknowledgements

感谢以下上游/参考项目对本项目 Grok 能力对接提供的支持（保留原仓库链接）：

- waoowaoo 原仓库 / Original repository: https://github.com/waoowaooAI/waoowaoo
- grok-art-proxy: https://github.com/xixianloux/grok-art-proxy

Special thanks to the maintainers and contributors of the upstream/reference project above.

---

**Made with ❤️ by waoowaoo team**

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=tvvshow/waoowaoo&type=date&legend=top-left)](https://www.star-history.com/#tvvshow/waoowaoo&type=date&legend=top-left)

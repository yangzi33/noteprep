# noteprep

noteprep.app

面向独立数学辅导老师的备课工具(AI Tutor Lesson Prep):输入主题与要求,生成可编辑的讲义、练习、独立答案与逐步解答,并导出学生版与教师答案版的 LaTeX 源文件和真正编译的 PDF。

## 当前状态:Phase 1 进行中(P1-T0 至 P1-T2 完成)

- 已有:固定的工具链、Next.js App Router 骨架(TypeScript strict、Tailwind、shadcn/ui)、`/healthz`、Vitest、架构边界的 ESLint 规则。
- **尚无**:数据库、认证、任务/额度、worker、Stripe、LLM、LaTeX 编译。页面只是占位,**不是可用产品**。
- 工作流与规则见 [CLAUDE.md](CLAUDE.md);设计见下方文档。

### 当前可用命令(均已在本机实际运行通过,2026-10-18)

前提:Node 24(`.nvmrc` 为 24.13.1)、pnpm 10.33.0。

```bash
pnpm install --frozen-lockfile
pnpm dev          # 本地开发服务器
pnpm lint
pnpm typecheck    # next typegen && tsc --noEmit
pnpm test         # Vitest 单元测试
pnpm build
```

尚未建立(见实施计划):`test:integration`、`test:e2e`、`worker:dev`、`test:latex`、`db:migrate:dev`、`db:migrate:deploy`。

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/product.md](docs/product.md) | 用户问题、MVP/非目标、端到端流程、3 次免费与订阅的精确语义、验收场景、成功指标定义 |
| [docs/architecture.md](docs/architecture.md) | 系统图、数据模型与约束、额度/任务事务伪代码、内容 schema 示例、数学验证、Stripe 权益、LaTeX 沙箱与部署 |
| [docs/implementation-plan.md](docs/implementation-plan.md) | Phase 1–4 依赖顺序、任务、验收证据、退出条件、风险 |
| [docs/test-plan.md](docs/test-plan.md) | 数学 fixtures、并发额度、故障恢复、权限隔离、Stripe 事件矩阵、沙箱负面测试、E2E;各层能证明什么 |
| [docs/security-and-privacy.md](docs/security-and-privacy.md) | 威胁模型、信任边界、数据清单、最小权限、删除与保留、未确定事项 |
| [docs/decisions.md](docs/decisions.md) | 已定约束、可逆默认、待决策事项、已核对的官方资料 |

## 技术栈(已安装部分:Next.js、React、Tailwind、shadcn/ui、Vitest;其余为计划)

Next.js App Router · TypeScript strict · Tailwind CSS · shadcn/ui · PostgreSQL + Prisma(稳定 7.x)· Supabase Auth 与私有 Storage · 薄的 provider-agnostic LLM 适配器(fake + 一个真实适配器)· 独立持久 worker(Postgres 任务表 + 租约)· 每任务隔离的 pdfLaTeX 沙箱 · Stripe 订阅 · pnpm · Vitest · Playwright · GitHub Actions · Vercel(仅 Web)。具体版本在 Phase 1 核对后固定。

## 未来的运行依赖(Phase 1 起需要;本机目前的检测结果)

| 依赖 | 用途 | 本机检测(2026-10-18) |
|---|---|---|
| Node.js(需满足 Prisma 要求 `^22.18 \|\| ^24.11 \|\| >=26`) | 运行 | v24.13.1 |
| pnpm | 包管理 | 10.33.0 |
| 容器运行时(Docker/Podman) | 本地 Supabase、真实 TeX 沙箱 | Docker client/server 29.8.2,Compose v5.6.0(`docker version`、`docker compose version`);WSL 集成已生效 |
| Supabase CLI | 本地 Auth/Storage/Postgres | 2.121.0(在临时目录用 `npx supabase --version` 检测;尚未加入项目依赖) |
| TeX Live | 仅在沙箱镜像内;不需要装在宿主 | 未检测到 |
| Stripe CLI | 本地 webhook 转发(测试模式) | 未检测 |

### 容器运行时与 Supabase CLI 的获取方式

以下为 2026-10-18 读取的官方文档摘要(来源:[Docker Desktop WSL](https://docs.docker.com/desktop/features/wsl/)、[Supabase CLI 入门](https://supabase.com/docs/guides/local-development/cli/getting-started));本轮**没有安装任何东西**,步骤须在 Phase 1 的 P1-T0 中实际执行并记录输出。

**容器运行时(本机为 WSL2;P1-T0 检测时已可用,以下步骤保留供其他机器参考)**

1. 在 Windows 上安装 Docker Desktop(WSL 2 版本至少 2.1.5,建议最新)。如果 WSL 发行版内另装了 Docker Engine/CLI,须先卸载,二者并存会冲突。
2. 用 `wsl.exe -l -v` 确认本发行版为 WSL 2;不是则 `wsl.exe --set-version <发行版名> 2`。
3. Docker Desktop → Settings → Resources → WSL Integration,为本发行版打开开关并 Apply。看不到该选项时,切换到 Linux containers。
4. 在本发行版终端运行 `docker version`,同时显示 Client 和 Server 信息才算成功。
5. 说明:Docker Desktop 足以支撑本地 Supabase。生产沙箱采用的 gVisor(`runsc`)属于 Linux worker 主机的需求,在 WSL/Docker Desktop 上能否复现须在 Phase 2 的沙箱 spike 中实测(待验证)。

**Supabase CLI**

- 推荐作为项目开发依赖安装并固定版本:`pnpm add -D supabase`,之后用 `pnpm supabase <命令>` 运行(需要 Node 20+;本项目 Node 满足)。这样不依赖全局安装,团队版本一致。该命令属于 P1-T1/P1-T5,届时才会修改 `package.json`。
- 替代:Linux 可用 Homebrew,或从其 GitHub releases 下载 `.deb`/`.rpm`/`.apk` 安装。
- 使用前提:先有可用的容器运行时(上一节)。基本命令:`supabase init`(只创建本地文件)→ `supabase start`(首次会下载镜像)→ `supabase stop`。
- 项目的本地启动流程、环境变量和 `.env.example` 将在 P1-T5/P1-T8 随真实脚本一起写入本 README。

## 下一阶段入口

Phase 1 已获授权并在 `feat/p1-foundations` 分支进行。下一个任务:**P1-T3 Prisma schema、迁移与数据库角色**(需要本地 Postgres/Supabase)。详见 [docs/implementation-plan.md](docs/implementation-plan.md)。

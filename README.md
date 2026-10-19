# noteprep

noteprep.app

面向独立私人 STEM(首个学科:中学数学)辅导老师的备课自动化:**选择**课程体系/级别/课程/主题与时长、难度,几分钟内得到一套排版专业的课包(Tutor Lesson Notes、Student Practice Worksheet、Solutions/Answer Key);预览、用预设快速调整,再导出 PDF。LaTeX 完全在幕后,老师不需要写或编辑 LaTeX。方向详见 [docs/product-vision.md](docs/product-vision.md)。

## 当前状态:Phase 1 已完成并合并;Phase 2 进行中(P2-T1、P2-T2 完成);产品方向已调整,重构里程碑待启动

- 已有:固定的工具链、Next.js App Router 骨架(TypeScript strict、Tailwind、shadcn/ui)、`/healthz`、Vitest、架构边界的 ESLint 规则、Prisma schema 与迁移(含 CHECK/部分唯一索引/触发器/运行时角色/RLS,见 [docs/database-roles.md](docs/database-roles.md))、真实 Postgres 上的集成测试。
- 额度与任务的 DAL 事务(`src/lib/server/dal`):账户初始化、创建生成(幂等 + 限流 + 预留 + 入队,一个事务)、取消、围栏式提交成功/失败结算;在真实 Postgres 上有并发与故障用例,并做过变异验证。
- 认证:`@supabase/ssr` + `proxy.ts` 仅刷新会话;`requireUser`/`requireAccount` 用 `getClaims` 验签(只接受非对称算法),邮箱经 `getUser()` 确认后才创建账户与试用额度;登录/注册/登出与 `/account` 页面;在真实本地 Supabase 上测试了伪造令牌、未确认邮箱、Data API 无法访问业务表。
- Worker 骨架(`worker/`,`pnpm worker:dev`):`SKIP LOCKED` 领取、租约+心跳、围栏 token、单一总预算、有界重试(指数退避+抖动)、取消、sweeper(过期租约/截止时间/重试用尽;释放预留;报告计数漂移)、优雅退出。流水线使用假 LLM、**仅骨架用的假编译器**(产物以 `SKELETON - NOT A COMPILED PDF` 开头,生产环境拒绝启动)和本地磁盘对象存储;数学验证与排版是 Phase 2 的占位。
- UI 骨架:导航、创建课包表单(幂等键随表单实例生成)、任务状态页(服务端渲染 + 轮询,刷新不丢)、取消、历史与剩余额度;所有页面与 `/api/jobs/[id]` 仅对所有者可见。课包文件目前是占位物,**没有下载功能**(Phase 2)。
- Playwright 端到端(真实浏览器 + 本地 Supabase + 真实 worker 进程):登录→生成→完成→历史;重复提交与刷新不重复消耗;取消返还额度;超时失败给出清晰提示并返还额度;三次后第四次被拒(页面与服务端);跨用户隔离;未登录重定向。
- **尚无**:Stripe、真实 LLM、数学验证、LaTeX 编译与沙箱、孤儿对象清理(P3)、IP 级限流接入(DAL 支持 `ipHash`,Web 尚未传入,P3-T2)。页面只是占位,**不是可用产品**。
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
pnpm db:up                 # 启动本地 Postgres 17(compose.yaml,127.0.0.1:54329,一次性开发凭据)
pnpm db:migrate:deploy     # 对 .env 中的 DATABASE_URL 应用迁移(先 cp .env.example .env)
pnpm test:integration      # 每次运行新建临时数据库、重放全部迁移、再跑测试
pnpm db:down
```

本地 Supabase(认证与 Data API 边界测试,以及运行应用):

```bash
cp .env.example .env       # 然后把 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY 换成 pnpm supabase:status 输出的值
pnpm supabase:start        # 首次会下载镜像;已在 supabase/config.toml 关闭暂不需要的服务
pnpm db:migrate:deploy     # 用 MIGRATION_DATABASE_URL 把迁移应用到 Supabase 的 Postgres
pnpm db:dev-roles          # 创建本地 web_login / worker_login(仅开发用的一次性密码)
pnpm test:supabase         # 真实 Auth + Data API 的边界测试
pnpm test:e2e              # Playwright:构建并启动应用(3100 端口),测试内启动真实 worker;需先 supabase:start,并已 `pnpm exec playwright install chromium`
pnpm worker:dev           # 单独的进程;读取 .env 里的 WORKER_DATABASE_URL,产物写到 .data/objects
pnpm dev                   # http://127.0.0.1:3000 ;注册邮件在 http://127.0.0.1:54324 (Mailpit)
pnpm supabase:stop
```


数据库注意事项:

- 本机 5432 端口可能被其他项目占用,所以本项目使用 54329。
- 非交互环境中请用 `db:migrate:deploy`;`db:migrate:dev` 需要交互式终端(生成新迁移时使用)。
- **不要重新运行 `prisma init`**:它会把第三方 "agent skills" 文本从 GitHub 下载到 `.agents/`、`.claude/`、`.windsurf/` 并写入 `skills-lock.json`。这些内容未经审阅,已删除且不应提交。
- `pnpm install` 会触发根包的 `postinstall`(`prisma generate`,不需要数据库连接),生成物位于被忽略的 `src/generated/prisma`。

尚未建立(见实施计划):`test:latex`(Phase 2)。`test:supabase` 与 `db:up`/`db:down` 等是额外加入的命令。

## CI

`.github/workflows/ci.yml`(pull request 与 push 到 `main`;PR 不使用仓库秘密):静态检查与构建、真实 Postgres 集成测试、本地 Supabase 栈的认证/Data API 边界测试。`.github/workflows/db-migrate.yml` 仅手动触发、仅 `main`、需要 `staging`/`production` 环境审批,用于对托管数据库执行 `prisma migrate deploy`。第三方 action 固定到提交 SHA;pnpm 通过 corepack 按 `packageManager` 精确版本安装。**`ci.yml` 已在 GitHub 上实际运行:PR #1 的三个作业全部通过(2026-10-19);`db-migrate.yml` 尚未运行过(需要你创建的环境与秘密)。** 端到端(Playwright)作业随 P1-T7 加入。Staging 准备清单见 [docs/staging-setup.md](docs/staging-setup.md)。

## 产品方向调整(2026-10-19)

产品改为**选择优先、课程感知、预览 + 调整**,取代原先的"输入需求 → 编辑器"。已批准的决定:MVP 目标课程是 **Ontario Grade 9 数学**,但**真实课程数据集是之后的独立里程碑**(CM,届时一并决定课程文本授权);**不向用户提供 `.tex`**(只导出 PDF);调整计费采用"确定性调整免费、含模型的调整消耗每课包调整额度"。文档与 `CLAUDE.md` 已按此对账。**里程碑 M1(课程域模型 + 示例数据集)已完成**(见下);M2(选择向导)尚未开始。详见 [docs/refactor-plan.md](docs/refactor-plan.md)。**已建成的是基础设施**(认证、额度/任务、worker、数学内核与题目生成器、选择→状态→历史的 UI 骨架、课程域);**尚无**真实课程数据(CM 里程碑)、选择界面、真实 LLM、LaTeX 渲染与沙箱、PDF 预览/导出、调整。

## M1 课程域(完成)

- **数据库**:12 张公共只读表(教育体系、课程体系、版本、级别、课程、单元、主题、学习目标、主题↔目标、先备知识、概念、主题↔概念),两个迁移(Prisma 生成的表 + 手写的约束/触发器/授权)。**已发布版本不可变**(触发器:不能增删改任何子行,版本行只能 published→superseded→withdrawn 向前);复合外键把整棵树锁在同一个版本内;`real` 数据集必须带来源 URL、检索日期和人工核对记录;文本有长度上限;运行时角色**只读**,Data API 角色无权限(真实 Supabase 栈测试覆盖)。
- **数据集管线**:`data/curricula/<课程>/<版本>/` 四个 JSON 文件 → `pnpm curriculum:validate`(CI 每次运行)→ `pnpm curriculum:load <目录> [--allow-sample]`(用迁移所有者连接,幂等、原子、只新增版本;同版本内容不同则拒绝)。
- **读取层** `createCurriculumDal`:可见性(只有已发布版本;示例数据仅在 `CURRICULUM_ALLOW_SAMPLE=1` 的开发/staging 可见,合成数据仅测试可见,**生产默认什么都看不到**)、级联选择选项(无级别的体系自动跳过级别步骤)、`resolveCurriculumContext`(不可变快照 + `contextHash`,拒绝不受支持的主题)。主题是否"受支持"只由**代码里的能力注册表**决定,数据库里多出来的概念不会让任何主题变成"受支持"。
- **示例数据集**:`data/curricula/sample-math/sample-1`——**完全虚构,处处标注"不是真实课程"**;用它生成的课包不允许任何对齐声明(`alignmentClaimsAllowed=false`)。真实 Ontario 数据集是之后的 CM 里程碑。
- 测试:单元 +36(数据集 schema/每条规则/能力注册表),集成 +38(加载、不可变性、约束、可见性、级联、上下文);7 项变异检查均被发现。

## Phase 2 进度

- **P2-T1 数学内核(完成)**:`src/lib/math`——BigInt 精确有理数(无浮点;拒绝小数/科学计数法/越界数字)、一元一次方程独立求解(唯一解/无解/恒等式)、逐步等价检查(声明的操作作用于上一步必须得到所写的结果,乘除零被拒,解集不得改变)、代入原方程、答案册核对、最终形式检查;状态 `verified/failed/unverified` **只由确定性检查产生**:任何失败→failed,必需检查未运行(例如没有步骤)→unverified;LLM 复审或随机抽样只能作为补充证据,**不能**让任何题变成 verified,发现疑点会把 verified 降为 unverified;报告绑定内容哈希,内容变化后旧结论视为 unverified。整课校验还检查题号唯一、答案册与练习一一对应、无孤立答案。
- 测试:`tests/fixtures/math` 里 32 道**人工审定**的单题用例(含无解、恒等式、分数/负系数、除以零、答案错误、步骤错误、"最终答案对但中间错"、"等价但不是所述步骤"、题答错位、不支持的写法)与 8 个整课用例,每个都带人工推导;已通过独立的 Python `fractions` 交叉核对,并做过 6 项变异检查(其中一项暴露了缺失用例,已补)。
- **P2-T2 参数生成器(完成)**:`src/lib/math/generator.ts`、`rng.ts`——**由代码选择参数、计算答案并写出每一步解答,LLM 不参与任何数学**。从选定的解反推参数,因此按构造有效;种子化的 SHA-256 随机数(跨平台一致、无浮点、无取模偏差),同一任务重试得到同一套题;按难度的可读性规则(basic:一边含 x、整数、答案非零且 ≤10;mixed:两种形式、可为负、整数答案;challenge:分数答案或 ±1/q 系数),题目与整套练习都不重复,`mixed` 为由易到难。无解/恒等式只在明确请求时生成。
  验证:对 11 种难度/形式/结果组合各取 400 个种子,**每道生成的题都被 P2-T1 的验证器判为 verified**;另用独立的 Python `fractions` 复算了 570 道题、1186 个步骤(与生成器和验证器均不共享代码),全部一致;6 项变异检查(错一步、允许零答案、允许系数 1、跳过去重、末步除错、无解写成恒等式)均被测试发现。
- 尚未做:内容 schema/修订(P2-T3)、LaTeX 渲染(P2-T4)、真实 LLM(P2-T5)、沙箱编译(P2-T6)等。

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/product-vision.md](docs/product-vision.md) | **新方向**:选择优先、课程感知、三份文档、预览 + 调整、输入模式路线图、完成的定义 |
| [docs/refactor-audit.md](docs/refactor-audit.md) | 对仓库的审计:子系统分类(KEEP/MODIFY/DEPRECATE…)、错位、与既有文档/CLAUDE.md 的冲突、课程来源核实结果 |
| [docs/curriculum-architecture.md](docs/curriculum-architecture.md) | 课程域模型(含"概念"层)、数据集管线、数据驱动的级联选择、可追溯性与降级 |
| [docs/refactor-plan.md](docs/refactor-plan.md) | 生成契约 v2、课包内容模型、预设调整、前端信息架构、里程碑 M0–M7 + CM、风险、估算、待决事项 |
| [docs/product.md](docs/product.md) | 用户问题、MVP/非目标、端到端流程、3 次免费与订阅的精确语义、验收场景、成功指标定义 |
| [docs/architecture.md](docs/architecture.md) | 系统图、数据模型与约束、额度/任务事务伪代码、内容 schema 示例、数学验证、Stripe 权益、LaTeX 沙箱与部署 |
| [docs/implementation-plan.md](docs/implementation-plan.md) | Phase 1–4 依赖顺序、任务、验收证据、退出条件、风险 |
| [docs/test-plan.md](docs/test-plan.md) | 数学 fixtures、并发额度、故障恢复、权限隔离、Stripe 事件矩阵、沙箱负面测试、E2E;各层能证明什么 |
| [docs/security-and-privacy.md](docs/security-and-privacy.md) | 威胁模型、信任边界、数据清单、最小权限、删除与保留、未确定事项 |
| [docs/decisions.md](docs/decisions.md) | 已定约束、可逆默认、待决策事项、已核对的官方资料 |
| [docs/database-roles.md](docs/database-roles.md) | 数据库运行时角色、授权与登录用户创建 |
| [docs/staging-setup.md](docs/staging-setup.md) | Supabase / Vercel / GitHub / Stripe / Linux 主机的 staging 准备清单 |

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

Phase 1 已完成并合并;P2-T1(数学内核)与 P2-T2(题目生成器)已完成。**下一步是重构里程碑 M1(课程域模型 + 示例数据集),尚未开始,等待你的启动批准**;原 Phase 2 的其余任务已被 [docs/refactor-plan.md](docs/refactor-plan.md) 的里程碑取代(对照表见 [docs/implementation-plan.md](docs/implementation-plan.md) §3)。真实课程数据与授权是之后的独立里程碑(CM)。沙箱 spike 需要一台 Linux 主机(见 [docs/staging-setup.md](docs/staging-setup.md) §5),可以提前准备。

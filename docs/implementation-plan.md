# 实施计划(Phase 1–4)

> 状态:计划,未开始。**不含工期或成本承诺**——没有依据。每个任务的完成以"验收证据"为准。
> 本轮(Phase 0)只产出文档;**Phase 1 需要用户另行授权后才能开始**(CLAUDE.md §2)。
> 相关:[architecture](architecture.md) · [test-plan](test-plan.md) · [security-and-privacy](security-and-privacy.md) · [decisions](decisions.md)

## 0. 依赖顺序总览

```
Phase 1 工程基线 + 身份/所有权 + 最小 schema/任务/额度 + 假数据纵向骨架
   │   (骨架:登录 → 提交 → 事务预留入队 → worker 领取/结算 → 状态与历史页)
   ▼
Phase 2 第一条真正可用的路径(仅一元一次方程 Type A/B)
   │   数学内核 → 内容 schema → 渲染 → 隔离编译 → 真实 LLM → 编辑/重验/定稿 → 下载
   ▼
Phase 3 额度并发与恢复完备 + 历史/删除 + Stripe 测试订阅 + 权益对账
   ▼
Phase 4 隐私/安全验证 + 可观测 + 成本/速率限制 + 恢复演练 + staging 端到端 + 发布说明
```

跨阶段铁律(CLAUDE.md §12):基本授权、原子额度、数学验证、沙箱隔离**不得**推迟到上线之后;后续阶段只扩大覆盖,不首次引入这些边界。

## 1. 命令契约及其落地阶段

脚本只有在"真正运行了某件事"时才加入 `package.json`;不放空壳脚本冒充能力。落地后以实际 `package.json` 为准。

| 命令 | 落地阶段 | 备注 |
|---|---|---|
| `pnpm dev` / `pnpm build` / `pnpm lint` / `pnpm typecheck` | P1-T2 | |
| `pnpm test` | P1-T2 | Vitest 单元测试 |
| `pnpm db:migrate:dev` / `pnpm db:migrate:deploy` | P1-T3 | `deploy` 仅用于非开发流程 |
| `pnpm test:integration` | P1-T3(随额度/任务逐步扩充) | 真实临时 Postgres;Supabase 边界另需本地 Supabase |
| `pnpm worker:dev` | P1-T6 | |
| `pnpm test:e2e` | P1-T7(骨架路径),P2 扩充 | Playwright |
| `pnpm test:latex` | P2-T6 | 需要容器运行时;**当前机器没有 Docker/TeX**,见 §2 P1-T0 |

## 2. Phase 1:工程基础与纵向骨架

**目标:** 建立可重复的工程基线,并用确定性假数据打通"登录 → 提交 → 原子预留入队 → worker 领取并结算 → 状态/历史页"。重点证明身份/所有权与额度原子性,而不是内容质量。

**明确不做:** 真实 LLM、真实数学内容、真实编译、Stripe、删除流程的完整物化清理。

### 任务

| ID | 任务 | 影响文件/模块 | 验收证据 |
|---|---|---|---|
| **P1-T0** | **环境前置核对**(本轮已知:Node v24.13.1、pnpm 10.33.0 可用;**Docker、TeX、Supabase CLI 未检测到**)。确认并在 README 写明本地依赖:容器运行时(Docker Desktop WSL 集成或 Podman)、Supabase CLI、Postgres 获取方式。缺失项只记录,不自行安装系统级软件。 | README | 列出每个依赖的版本检查命令与实际输出 |
| **P1-T1** | 固定工具链:`.nvmrc`/`engines`(Node 须满足 Prisma 要求 `^22.18 \|\| ^24.11 \|\| >=26`)、`packageManager` 字段固定 pnpm、单一 `pnpm-lock.yaml`、`.gitignore`、`.env.example`(仅占位符)。依据 registry 当时输出与官方文档**逐项核对后**固定 next / prisma(稳定 7.x,**不用 RC**)/ stripe / @supabase/ssr / zod / vitest / playwright / tailwind 版本。 | 根目录配置文件 | `pnpm install --frozen-lockfile` 在干净克隆成功 |
| **P1-T2** | Next.js App Router + TypeScript `strict` + Tailwind + shadcn/ui 骨架;ESLint(含 `no-restricted-imports`:仅 `src/lib/server/dal/**` 可导入 Prisma)、`server-only`;Vitest。一个 `/healthz`(无敏感信息)。 | `src/app`, `src/components`, `eslint` 配置 | `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部实际通过(记录输出) |
| **P1-T3** | Prisma schema + 首批迁移:Profile、Lesson、LessonRevision、GenerationJob、IdempotencyKey、UsageBucket、UsageReservation、Subscription、WebhookEvent、RateLimitWindow;**手写 SQL 部分**:CHECK(`used+reserved<=limit` 等)、部分唯一索引、触发器(finalized 不可变)、角色(`app_runtime`/`worker_runtime`/`migrator`,无 BYPASSRLS/CREATEDB)、RLS 启用与 `anon`/`authenticated` 零授权。迁移从空库可重放。 | `prisma/`, `src/lib/server/db` | 集成测试:从空库迁移成功;约束违例测试;`\du`/授权检查脚本证明角色无高权限 |
| **P1-T4** | 额度领域:`src/lib/domain` 纯函数(状态迁移、bucket 选择规则)+ DAL 事务(`createGeneration`、`commitSuccess`、`releaseFailure`、取消),含可重试事务(40001/40P01)。 | `src/lib/domain`, `src/lib/server/dal` | 并发集成测试:最后 1 次额度的 N 路竞争恰好 1 成功;同键重试只消耗一次;同键异请求 409;任一结算路径下 `reserved/used` 不变量成立 |
| **P1-T5** | 认证:本地 Supabase,`@supabase/ssr`,`proxy.ts` 仅刷新会话;`requireUser()`(`getClaims`)、`ensureProfile`(幂等,创建 trial bucket,须邮箱已验证);登录/登出页。 | `src/lib/server/auth`, `src/app/(auth)` | 集成测试(本地 Supabase):伪造的 userId/Cookie 被拒;重复回调不产生第二个 trial bucket;DAL 跨用户矩阵测试全部拒绝 |
| **P1-T6** | Worker 骨架:`worker/` 单一入口、领取(`SKIP LOCKED`)、租约/心跳/围栏、sweeper(过期租约、取消、deadline)、指数退避+抖动;**流水线使用 fake LLM + 仅测试可用的 fake 编译端口**(见下方"骨架测试缝")。 | `worker/`, `src/lib/llm/fake` | 集成测试:worker 崩溃/租约过期 → 重新排队,不重复消耗;旧 worker 晚到提交被拒;取消释放预留 |
| **P1-T7** | UI 骨架:创建表单(Zod 校验,幂等键随表单实例生成)、任务状态轮询页(刷新不丢)、历史与剩余额度页、额度用尽提示。 | `src/app`, `src/components` | Playwright:登录 → 提交 → 状态走到终态 → 历史可见;刷新/后退不重复消耗(骨架路径) |
| **P1-T8** | CI(GitHub Actions):固定 runner/Node、`--frozen-lockfile`、最小 `permissions`、第三方 action 固定到提交 SHA、外部 PR 不暴露秘密;作业:lint/typecheck/unit/integration(Postgres 服务容器)/build/e2e(骨架)。README 补全本地启动与环境变量说明。 | `.github/workflows`, README | 一次真实 CI 运行的链接/记录;README 中每条命令都在干净环境按文档执行过 |

**骨架测试缝(必须遵守):** Phase 1 的 worker 需要走到"成功"才能验证结算,因此引入一个 `CompilerPort`,其唯一的非真实实现 `FakeCompiler` 仅在 `NODE_ENV=test` 或显式 `ALLOW_FAKE_COMPILER=1`(本地开发)下可被注入,生成的产物文件内容明确标注 `SKELETON — NOT A COMPILED PDF`。生产配置校验在启动时拒绝该标志(有测试)。它**不是**"假 PDF 冒充成功编译"的产品行为,Phase 2 以真实隔离编译取代,并删除骨架路径对它的依赖。

### 退出条件

- 上述任务的验收证据全部存在(命令输出/CI 记录),未运行的检查明确列出。
- 并发额度、幂等、围栏、取消、跨用户拒绝的测试通过,且包含针对"删去保护后测试会失败"的反向验证(至少对 CHECK 约束与围栏各做一次变异验证)。
- 迁移可从空库重放;角色权限检查通过。
- 文档与配置同步(README、`.env.example`、本目录文档)。

### 风险

- Docker/Supabase CLI 在当前 WSL 环境不可用 → P1-T0 先解决,否则集成测试无法运行(不得以 mock 代替 RLS/Auth/Storage 的证明)。
- Prisma 主版本迁移中(`latest` 为 RC)→ 固定稳定 7.x,Prisma 的事务/隔离级别 API 以所固定版本的文档为准(本轮抓到的是新版文档,**不可直接套用**)。
- 事务池(pgbouncer)与交互式事务、`pg_advisory_xact_lock`、`SET LOCAL` 的组合需实测。

## 3. Phase 2:第一条真正可用的路径

**目标:** 一元一次方程 Type A/B 的完整真实路径:真实 LLM(仅文字)+ 确定性数学 + 隔离编译 + 编辑/重验/定稿 + 下载。**范围守卫:** 不扩题型;括号/分配律等需在 Phase 2 验收后单独评审。

| ID | 任务 | 验收证据 |
|---|---|---|
| **P2-T1** | `src/lib/math`:有理数(BigInt)、线性方程一边/两边表示、独立求解、步骤等价检查、`validationReport` 构造与状态聚合。**先写人工核对的 fixtures**(含 §architecture 7.2 的三例,加:恒等式、无解、负系数、分数系数、除以零步骤、答案错误、步骤错误、题答错位、不支持表达式)。 | `pnpm test`:每个 fixture 的期望状态(verified/failed/unverified)与人工结论一致;包含"故意写错"的负例 |
| **P2-T2** | 参数生成器(种子可复现、难度表)+ 属性测试(生成的题必为 verified,且答案符合难度可读性规则)。 | 属性测试通过;种子复现测试 |
| **P2-T3** | 内容 schema(Zod,`lesson-content/1`)、LessonDraft/Revision 读写、内容哈希、逐题失效逻辑。 | 单元+集成测试:编辑一题只使该题验证项作废;finalized 后内容不可变(触发器测试) |
| **P2-T4** | `src/lib/latex`:转义、结构化→LaTeX 渲染(学生版/教师版)、模板 v1(pdfLaTeX、A4)、字符集限制;学生版渲染输入类型不含 `answerKey`。 | 单元测试:转义/注入用例(`\write18`、`\input`、`\def` 等作为文本被转义);学生版 `.tex` 不含任何答案串 |
| **P2-T5** | 真实 LLM 适配器(默认 Anthropic,可配置)、提示词(仓库内、版本化)、输出 Zod 校验、错误分类、预算计量;小型真实质量/成本评估脚本(**单独手动运行,不进 PR**)。 | provider 错误分类单元测试;fake 与真实适配器通过同一契约测试;一次受控评估的记录(成本、失败率、人工抽查) |
| **P2-T6** | **沙箱 spike → 镜像 → runner**:先做带负面测试的 spike(见 test-plan §6),在目标平台选定 runner 机制;构建固定摘要的 TeX 镜像;`pnpm test:latex`。**任何"必须实测能力"不满足即阻断,回到架构替代方案评审。** | 真实镜像上:两份有效 PDF;全部负面测试通过;清理验证 |
| **P2-T7** | 真实流水线:校验→生成文字→合并参数→数学验证(有界修复)→渲染→沙箱编译→上传(attempt 前缀)→事务提交(§architecture 6.5),替换骨架 `FakeCompiler`。 | 集成+故障注入:6.6 故障矩阵逐项有测试(提交前/后崩溃、旧 worker 晚到) |
| **P2-T8** | 编辑器(受限字段、KaTeX 预览)、重验证、定稿(未验证项逐项确认)、`compile` 任务(不消耗生成额度)。 | E2E:编辑→重验→定稿→编译→下载;failed 阻止导出;未验证需确认且保持标记 |
| **P2-T9** | 授权下载(签名短时 URL、no-store)、历史页对修订版的下载。 | 跨用户下载被拒;URL 过期;同一 revisionId 的预览/答案/下载一致 |
| **P2-T10** | 第一条完整 E2E(fake LLM)+ 一次真实 LLM 的受控全链路手动验证。 | E2E 通过;手动验证记录(含人工数学抽查) |

### 退出条件
- 真实编译、真实隔离、两份版本各自的 `.tex`+PDF 可下载;学生版文本检查无答案。
- 数学 fixtures 与属性测试通过;至少一轮人工数学抽查记录(抽样规则与结果)。
- 所有"未运行的检查"在 README/test-plan 状态栏中标明。

### 风险
- gVisor 在目标主机上与 TeX 的兼容性与性能(备选:Firecracker)。
- LLM 文字输出难以满足"叙述不含数字"约束 → 采用模板化叙述兜底(降级为较少的 LLM 自由度,而不是放宽验证)。
- pdfLaTeX 字符集限制导致合法输入被拒 → 提供明确错误并记录需求,是否切换 XeLaTeX 走决策流程(D-05)。

## 4. Phase 3:额度并发、恢复、历史/删除、Stripe

| ID | 任务 | 验收证据 |
|---|---|---|
| **P3-T1** | 完整并发/恢复测试矩阵(test-plan §3–4):故障注入覆盖所有阶段;不变量检查器作为测试断言与 sweeper 告警。 | 全部必需用例(CLAUDE.md §11)通过 |
| **P3-T2** | 持久速率/并发/成本限制:`RateLimitWindow`、每账户并发、24h 成本上限、连续失败熔断、全局积压上限。 | 反复失败不能产生无限计算的测试(计数不因失败退还) |
| **P3-T3** | 历史与删除:课包删除(先阻断、后物化清理)、账户删除流程(取消订阅、在途任务、对象、记录)、保留例外。 | "取消/删除后在途 worker 不能重新发布"测试;恢复流程不复活已删除内容 |
| **P3-T4** | Stripe(**测试模式**):Checkout/Portal 服务端创建(价格 ID 白名单)、webhook(验签、持久记录、异步处理)、订阅同步(advisory lock + 读取当前状态)、paid bucket 创建、权益状态表、对账任务。 | 事件矩阵(test-plan §7)逐项通过;三个案例有专门测试 |
| **P3-T5** | 订阅 UI:订阅/管理账单、额度显示、到期后的历史访问。 | E2E:耗尽试用 → 测试模式订阅 → 新生成 |

### 退出条件
CLAUDE.md §11 列出的必需用例全部有通过证据;Stripe 测试模式端到端(含失败/乱序/重复)通过;不变量检查在压力测试下无违例。

### 风险
Stripe 周期字段随 API 版本变化、支付失败后的状态机细节、Checkout 竞态;用固定 API 版本与"读取当前状态"策略降低,不依赖事件顺序。

## 5. Phase 4:隐私/安全验证、可观测、发布准备

| ID | 任务 | 验收证据 |
|---|---|---|
| **P4-T1** | 威胁模型逐项验证(security-and-privacy §4):授权、IDOR、CSRF/Origin、SSRF、XSS、缓存、日志脱敏。 | 针对每个场景的测试或记录 |
| **P4-T2** | 可观测:结构化日志(无内容)、指标(失败率、阶段耗时、token/成本、重试、webhook 积压、队列滞留)、最小告警。 | 告警规则文件 + 触发演练记录 |
| **P4-T3** | 成本/速率阈值定值(基于真实成本数据)。 | 配置+依据记录 |
| **P4-T4** | staging 全链路:真实 Supabase Auth/Storage、Stripe 测试支付、真实 LLM、真实沙箱;并发结算压测。 | 运行记录 |
| **P4-T5** | 恢复演练:数据库与 Storage 备份恢复;worker 重启/发布演练;密钥轮换。 | 演练记录 |
| **P4-T6** | 隐私文档与保留/删除路径、子处理方披露、数据地区(待决)。 | 文档审阅记录 |
| **P4-T7** | 发布说明:迁移顺序、worker 滚动、回滚、Stripe 生产切换检查单(**由人手动执行,不自动开通付费资源**)。 | 检查单 + 预演 |

### 上线门槛(必须有真实运行证据,缺一不可)
真实 LLM 提供商运行 · Supabase 会话 + 私有 Storage + RLS 实测 · Stripe 测试支付与 webhook 全矩阵 · 真实隔离编译及负面测试 · 并发结算压力证据 · 人工数学抽查记录 · 备份恢复演练 · 成本限制已配置并验证 · 价格/币种/额度/数据地区/隐私政策已由用户决定。

### 风险
未确定的商业与合规事项(见 [decisions](decisions.md) 第 3 节)会阻塞上线而不是阻塞开发。

## 6. 不在计划内(直至验收后另行评审)
扩题型(括号/分配律、分数方程、不等式)、其他学科、部分 AI 重写(其计费语义未明确)、实时通信、多模板/多语言。

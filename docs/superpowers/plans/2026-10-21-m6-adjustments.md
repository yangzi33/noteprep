# M6:预设调整与极小更正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏既有额度、作业、存储与沙箱不变量的前提下,让导师对已完成的课包施加**文档级预设调整**(D-61)与**文字字段的极小更正**(D-34)。每次改动都在 worker 里产出一个**经验证、渲染、沙箱编译的完整草稿修订**,导师预览后**接受**(成为当前版本)或**丢弃**。未受影响的节保持逐字节相同;调用模型的调整按 D-33 方案 B 消耗每课包调整额度。

**Architecture:** 纯函数核心 `planAdjustment` / `applyAdjustment` / `applyCorrections` 放在 `src/lib/package/`(不做 I/O,确定性,种子可复现)。执行复用现有持久作业表:`generation_job` 新增 `kind='adjust'`,并加两列(`source_revision_id`、`adjustment`)。worker 复用现有的检查点、租约、围栏、重试、渲染、编译、存储路径,只把提交换成新的 `commitAdjustment`。它插入 `lesson_revision(status='draft', origin='adjust'|'correct')`,**不**改 `lesson.current_revision_id`。接受和丢弃各是一个很短的、按所有者过滤的 Web 事务。LLM 调整额度复用 `usage_bucket` / `usage_reservation`:新增 bucket 种类 `adjustment`,按课包建一行,由触发器保证调整永远不碰 trial/paid bucket。

**Tech Stack:** TypeScript strict、zod 4.6.7、Prisma 7.x + 手写 SQL 迁移(PostgreSQL 17,`compose.yaml:6`、`supabase/config.toml:41`)、Vitest 5.0.5、Playwright;**不新增依赖**(refactor-plan §1)。属性测试用项目自带的确定性 `Rng`(`src/lib/math/rng.ts`)做种子化生成循环,不引入 fast-check。

**Spec:** `CLAUDE.md` §4、§5(D-33 句)、§7、§10、§11;`docs/refactor-plan.md` §3、§4、§6 M6/M7;`docs/decisions.md` D-30..D-39、D-58..D-64;`docs/architecture.md` §6.5–§6.6、§7.6;`docs/superpowers/plans/2026-10-20-figma-ui-implementation.md` §0/U6;`docs/superpowers/plans/2026-10-20-ui-lesson.md`。

## Global Constraints

- **3 次免费生成不变**:调整与更正永远不预留、不消耗 trial/paid bucket。这一条由 DB 触发器强制(Task 20),不只靠代码约定。确定性调整与更正不调用模型:其作业预算 `max_calls = max_tokens = max_cost_micros = 0`,任何模型调用都会被 `chargeUsage` 判为超限而失败(`src/lib/server/dal/jobs.ts:118-127`)。
- **单向预留与一次结算**沿用:`reserved → consumed|released`(`prisma/migrations/20261019030000_constraints_roles_rls/migration.sql:24-36`)。发布草稿、job=succeeded 与(LLM 调整的)consumed 在同一事务内完成;失败、取消或超时释放;自动重试复用原预留。
- **围栏**:worker 的每次写入都带当前 fencing token;晚到的旧 attempt 不得发布或消耗(沿用 `lockRunning` / `lockJob`)。
- **源修订不可变**:调整失败或取消时源修订不变(finalized 修订本身由 `lesson_revision_guard` 保护,迁移文件 `:115-142`)。
- **数学内容不可手改**:题目、答案、步骤、书写空间、计时、对齐、目标/先备列表都不可更正;数学只经确定性生成器重新生成,并经 `validatePackage` 全量复验。
- **未受影响的节逐字节相同**(定义见 §2.3):属性测试覆盖。
- **每个 Web 方法**从已验证会话取 `ctx.userId`,不接受客户端传入的 userId;他人或已删除的资源一律表现为 `NotFound`。
- 不暴露 `.tex`(D-31);日志不含课包内容、更正文字、提示词或签名 URL。
- `buildPackage` 对任何输入的输出**不得改变**(M3a 的确定性与既有测试依赖它),只允许追加可选字段的读取路径。
- 迁移只追加或放宽;`ALTER TYPE … ADD VALUE` 单独成一个迁移文件(新值不能在同一事务里使用)。
- 提交信息英文,末尾两行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` 与 `Claude-Session: https://claude.ai/code/session_017MC7wV8mFJaMoMZRYyWtPK`;只按明确路径 `git add`;每个切片一个分支 `feat/m6-<slice>`。
- **WSL 无 Docker**:`pnpm test:integration`、`pnpm test:latex`、`pnpm test:supabase`、`pnpm test:e2e` 在本机不可运行时**不得声称通过**,报告里写"未运行"。

## Review Focus

- 调整作业的预留只能指向本课包的 `adjustment` bucket;生成作业的预留只能指向 trial/paid(Task 20 触发器 + 集成测试)。
- 草稿接受与 worker 提交、丢弃、新调整入队的竞争:全部先锁 `lesson` 行(`FOR UPDATE`)再判"头修订"(Task 13/14/16)。
- 校验器现在用包级种子和请求难度重算 `inputsHash`,调整后的节会被误判失败 → Task 2 改为按节溯源取参数,且旧课包仍为 verified。
- "逐字节相同"与 `references` 边的哈希定义冲突(见 §1 冲突 2)→ 在计划里给出精确定义并用属性测试锁定。
- 草稿带清单原被 CHECK 禁止(`…constraints_roles_rls/migration.sql:112`,`tests/integration/schema.test.ts:361`)→ 只为 `origin<>'generate'` 放宽,既有测试含义不变。
- 更正文字是**用户输入**:prose 规则、长度、不得增删块、标题也要检查(现有校验器不检查标题)。

---

## 1. 现状核查(带证据)与对 refactor-plan §4 草案的修正

### 1.1 数据模型与触发器

| 事实 | 证据 |
|---|---|
| `JobKind` 只有 `generate`、`compile` | `prisma/schema.prisma:21-26` |
| `RevisionStatus` 已有 `draft`/`finalized`/`rejected`,代码里从不写 `draft`/`rejected`(生成只写 `finalized`) | `prisma/schema.prisma:62-68`;`src/lib/server/dal/settlement.ts:129` |
| 修订有 `sourceRevisionId`(自引用 FK,`ON DELETE SET NULL`)、`artifactManifest`、`createdByJobId` | `prisma/schema.prisma:145,150-151`;`prisma/migrations/20261019024909_init_schema/migration.sql:251` |
| **只有 finalized 修订可以有清单** | `…constraints_roles_rls/migration.sql:112`;测试 `tests/integration/schema.test.ts:361` |
| finalized/rejected 不可变,清单写一次;draft 可任意修改 | 同文件 `:115-142`;测试 `schema.test.ts:333-346` |
| `lesson.current_revision_id` 只受 FK `(current_revision_id,id)→(id,lesson_id)` 约束,**不检查状态** | `init_schema/migration.sql:245` |
| 作业守卫:终态不可改,身份字段不可改,token 不减 | `…constraints_roles_rls/migration.sql:66-84` |
| 预留形状(延迟约束触发器):generate 必须有预留,compile 必须没有;**不认识其它种类** | 同文件 `:87-100` |
| 漂移视图按 bucket 汇总预留行,不区分 bucket 种类 | 同文件 `:39-46` |
| bucket 形状 CHECK 只允许 trial/paid | 同文件 `:12-15`;trial 唯一部分索引 `:18` |
| `rate_limit_window(key, window_start)`,目前只用小时窗口 | `prisma/schema.prisma:305-312`;`src/lib/server/dal/generation.ts:65-72` |
| 幂等键主键 `(owner_id, operation, key)` | `prisma/schema.prisma:208-221` |
| `lesson.input_spec` 与课程钉住字段不可变 | `20261019092400_lesson_curriculum_columns/migration.sql:26-38` |
| Storage RLS 只检查"本人前缀 + `.pdf`",不知道修订状态 | `20261019230000_storage_artifacts/migration.sql` 第 18–27 行(策略 `lesson_artifacts_owner_reads_pdf`);D-48 |

### 1.2 课包、哈希、校验

| 事实 | 证据 |
|---|---|
| 溯源 `provenance` 是 strict 对象:`method`、`seed?`、`generatorVersion?`、`promptVersion?`、`model?`;节有 `inputsHash`、`contentHash`、`edited?` | `src/lib/package/schema.ts:62-76` |
| `PackageSchema` 有包级 `seed`,**没有** refactor-plan §3.3 所说的 `validation` 字段 | `schema.ts:125-139` |
| notes 文档必须包含全部 8 种节(含 `derivation`) | `schema.ts:119-123`;校验 `validate.ts:114-122` |
| `contentHash` = hash(kind,title,blocks);`inputsHash` = hash(kind, params, **上游节的 contentHash**) | `src/lib/package/hash.ts:7-14` |
| 依赖边固定:objectives→explanation(ref)、objectives→exercises(ref)、explanation→worked_examples(ref)、exercises→solutions(derives) | `src/lib/package/build.ts:70-75`;校验要求与规范集合完全一致 `validate.ts:124-128` |
| `dependentsOf` 沿**所有**边(含 references)求传递闭包 | `build.ts:328-342` |
| **校验器用包级 `pkg.seed` 与 `request.difficulty` 重算每节 `inputsHash`** | `validate.ts:136-153`(`:145-146`) |
| `llm` 参数只在 `method==="llm"` 时加入 | `validate.ts:134`;`build.ts:90-108` |
| 校验器只对段落、列表、步骤、计时标签做文字检查,**不检查节标题** | `validate.ts:34-43` |
| objectives/prerequisites 的列表必须逐字等于数据集 | `validate.ts:69-80` |
| 提纲分钟数之和必须等于 `outline.totalMinutes`(不与请求比较) | `validate.ts:96-98` |
| 练习与解答 id 顺序必须一一对应 | `validate.ts:162-167` |
| 构建器:`planOutline` 由课时决定练习数(3–12)与例题数(1–3) | `build.ts:40-48` |
| 例题与练习不重复方程(指纹 = `JSON.stringify(equation)`),练习最多重抽 20 次 | `build.ts:50-65` |
| 非 basic 时追加一道"无解"例题,并在末尾加注 "The last example has no solution…" | `build.ts:57,192` |
| 节的 `provenance.seed` 写的是包级种子 | `build.ts:299` |
| 每节提纲的 `objectiveIds` 都是全部目标(题目没有按目标标注) | `build.ts:307,315` |
| 流水线以 `lesson.id` 作为种子 | `worker/pipeline.ts:180` |
| prose 规则禁止任何数字、`=$\<>{}^_~|`、URL、课程词(`curricul\w*` 等)、元指令 | `src/lib/package/prose-rules.ts:8,35,40,42` |

### 1.3 数学生成器

| 事实 | 证据 |
|---|---|
| 同一种子与选项 → 同一道题;RNG 种子 = `GENERATOR_VERSION|seed|difficulty|form|outcome` | `src/lib/math/generator.ts:164`;`rng.ts` 用 SHA-256,跨平台确定 |
| `generateExerciseSet` 的题号从 1 开始,**无偏移参数**,也**不能排除外部指纹** | `generator.ts:225-243`(`:231`) |
| mixed 按三分之一分段:basic→mixed→challenge | `generator.ts:211-215` |
| **没有"详细步骤模式"**;步骤固定由 `solveOneSided`/`solveTwoSided` 产生;校验器只接受 4 种运算 | `generator.ts:73-90`;`src/lib/math/linear.ts:35-40`;`validate.ts:167`(math) |
| 结论:新种子、新难度、新题数都可以确定性重生成;追加题需要新增可选参数 `startIndex` 与 `exclude` | — |

### 1.4 Worker、DAL、结算

| 事实 | 证据 |
|---|---|
| `claimNext` **只领取 `kind='generate'`** | `src/lib/server/dal/jobs.ts:73` |
| `ClaimedJob` 不含 kind | `jobs.ts:8-17` |
| `getInput` 只返回 `lesson.input_spec`(按 token 与 running 过滤) | `jobs.ts:106-112` |
| 重试、退避、截止、扫描器都与种类无关,失败路径通过 `finishLockedJob` 按 job_id 释放预留(无预留时无操作) | `jobs.ts:134-203`;`reservation.ts:8-40` |
| `commitSuccess` **拒绝非 generate**;锁 lesson 用 `FOR SHARE`;要求 verified;v2 清单的文档集合取自 `lesson.input_spec`;插入 finalized 并设 current;消耗预留,无预留即回滚 | `settlement.ts:86-166`(`:96`、`:99-103`、`:105`、`:109-117`、`:123-142`、`:144-151`) |
| v2 清单要求每个文件都在**本 attempt 的前缀**下 | `src/lib/domain/manifest.ts:79-81,87-105`(`:99`) |
| `createGeneration`:锁 profile → 幂等 → 解析上下文 → 小时限流(用户/IP)→ **活跃作业数(不分种类)** → 全局积压 → 预留 → 建 lesson/job/预留 | `generation.ts:102-200`(`:166-169`) |
| 每次生成新建一个 lesson,所以一个 lesson 只有一个 generate 作业 | `generation.ts:179` |
| `cancelJob` 与种类无关,queued 时释放预留 | `generation.ts:214-237` |
| 历史只列 generate 作业 | `src/lib/server/dal/history.ts:58` |
| 课包页的读取只接受 `status='finalized'` | `src/lib/server/dal/lessons.ts:57-70`(`:66`);测试 `tests/integration/lesson-request-v2.test.ts:820-826` |
| 作业页成功后用 `getLessonView(…, revisionId)` 跳到 `/lessons/{id}?rev=…` | `src/app/jobs/[id]/page.tsx:20-28` |
| 流水线:检查点(心跳 + 取消/失租)、构建、校验(非 verified 即不可重试失败)、渲染、编译(只有 `sandbox_unavailable` 可重试)、存储(先写后校验)、提交;attempt 失败时清理自己的前缀 | `worker/pipeline.ts:116-121,178-196,248-316,86-105` |
| 渲染页眉读取 `pkg.request.difficulty/durationMinutes` | `src/lib/latex/render.ts:91-100`(`:93-96`);HTML 预览同样 `src/lib/package/html-view.ts:122-127` |
| DAL 键集合被测试锁定 | `tests/integration/ownership.test.ts:47-52` |
| Web 限额是代码常量 `DEV_DEFAULT_LIMITS`,经依赖注入覆盖,不读环境变量 | `src/lib/domain/generation.ts:30-52`;`src/lib/server/env.ts:5-9` |

### 1.5 refactor-plan §4 草案与代码的冲突及修正

1. **"展开分步解答 = 生成器的详细模式"**:生成器没有这种模式,校验器的运算集合是固定的(§1.3)。**修正**:推迟。要做,需要新增可验证的步骤类型(例如"代入检验"),同时改生成器、`linear.ts`、校验器、渲染器与 HTML 视图,并提升 `GENERATOR_VERSION`。
2. **"未受影响的节内容与哈希逐字节相同"**:`inputsHash` 包含上游 `contentHash`(`hash.ts:12-14`),所以更正 explanation 后,worked_examples(经 references 边)的 `inputsHash` **必须**变,否则校验器报 `INPUTS_HASH_MISMATCH`(`validate.ts:152`)。**修正**:把节分为三类:`unchanged`(整个 Section JSON 逐字节相同)、`rehash`(title/blocks/contentHash/provenance 相同,只重算 inputsHash)、`regenerate`。"无关节逐字节相同"指 `unchanged`;`rehash` 节保证读者可见内容逐字节相同。备选方案"inputsHash 只计 derives 边"会让所有已存课包校验失败,不采用。
3. **校验器写死包级种子与请求难度**(`validate.ts:144-150`):调整后的节必然失败。**修正**:按节取 `provenance.seed ?? pkg.seed`、`provenance.difficulty ?? request.difficulty`(Task 2);只有被调整过的节写入这两个覆盖值,构建器输出不变。
4. **"调整创建新的草稿修订……编译后才发布"**:现有 CHECK 不允许草稿带清单。**修正**:草稿 = "已完成、已验证、已编译、待接受";为 `origin<>'generate'` 放宽 CHECK,并加更严的守卫(Task 10)。
5. **"减少理论讲解 = LLM 重写或确定性删减推导"**:删掉 derivation 节会违反 notes 的节集合规则(§1.2)。**修正**:只做 LLM 版本(S4/S6),或另立决定改 schema。
6. **"增加例题 = worked_examples 追加"**:追加到无解例题之后,会让 "The last example has no solution" 变成假话(`build.ts:192`)。**修正**:插在最后一道唯一解例题之后、无解例题与注释之前。
7. **"聚焦某个课程目标"**:题目没有按目标标注(`build.ts:315`),单概念生成器不存在确定性含义。**修正**:推迟,需要先有目标到题型的映射。
8. **页眉显示请求里的难度与课时**:调整后会说错。**修正**:新增 `effectiveSettings(pkg)`(Task 1)。
9. **领取、提交、预留形状、活跃数都只认 generate**(§1.4)。**修正**:Task 10/14/15/16。
10. **`dependentsOf` 沿 references 传播**:用它决定"重生成"会过度重生成。**修正**:重生成只沿 derives 闭包;references 下游只做 rehash。

---

## 2. 设计

### 2.1 数据模型(迁移 C,分两步 + S4 的一步)

**`generation_job`**(S2):
- 枚举 `job_kind` 加 `adjust`(单独迁移)。
- 新列 `source_revision_id uuid NULL`,FK `(source_revision_id, owner_id) → lesson_revision(id, owner_id) ON DELETE RESTRICT`。
- 新列 `adjustment jsonb NULL`:`{ requestVersion:1, change:{…}, method:"deterministic"|"llm" }`。
- CHECK `(kind='adjust') = (source_revision_id IS NOT NULL AND adjustment IS NOT NULL)`。
- 守卫:两列不可变。
- 预留形状触发器:`adjust` 当且仅当 `adjustment->>'method'='llm'` 时必须有预留。

**`lesson_revision`**(S2):
- 新列 `origin text NOT NULL DEFAULT 'generate'`,CHECK 取值 `generate|adjust|correct`。
- 新列 `base_revision_id uuid NULL`(草稿链所基于的 finalized 修订),FK `(base_revision_id, lesson_id) → lesson_revision(id, lesson_id)`。
- 用 `(status='finalized' OR origin<>'generate') OR artifact_manifest IS NULL` 替换 `lesson_revision_manifest_only_finalized`。
- 新增 CHECK `origin='generate' OR (artifact_manifest IS NOT NULL AND validation_status='verified' AND source_revision_id IS NOT NULL AND base_revision_id IS NOT NULL)`:调整修订生来完整。
- 唯一部分索引 `lesson_revision_one_open_draft ON (lesson_id) WHERE status='draft' AND origin<>'generate'`。
- 守卫扩展:`origin`、`base_revision_id` 永远不可变;`OLD.status='draft' AND OLD.origin<>'generate'` 时,只允许 `status` 变为 `finalized` 或 `rejected`,其余字段(含清单)全部不可变。
- **新触发器 `lesson_current_revision_guard`**(BEFORE UPDATE ON lesson):新的 `current_revision_id` 非空时必须指向 `status='finalized'` 的修订。草稿永远不能直接成为当前版本。

**状态语义**:
- `draft + origin∈{adjust,correct}` = 待接受(每个课包最多一个,称"打开的草稿")。
- `finalized` = 已接受(或生成)。
- `rejected + origin<>'generate'` = 已丢弃或被后续草稿取代。
- "头修订" = 打开的草稿 ?? `lesson.current_revision_id`。新调整的源必须是头修订(可以在草稿上叠加多次)。
- **接受**(一个事务):锁 lesson → 无活跃调整作业 → 草稿是打开的且 `base_revision_id = current_revision_id` → `status='finalized'` → `current_revision_id = 草稿`。
- **丢弃**:锁 lesson → 无活跃调整作业 → `status='rejected'`。
- 当前版本只会因"接受"而改变(一个 lesson 只有一个 generate 作业,`generation.ts:179`),所以打开草稿的 base 必然等于当前版本;`base_revision_id` 是纵深防御。

**S4 `usage_bucket`**:
- 枚举 `bucket_kind` 加 `adjustment`(单独迁移)。
- 新列 `lesson_id uuid NULL`,FK `(lesson_id, owner_id) → lesson(id, owner_id)`。
- 重写形状 CHECK,增加 `kind='adjustment' AND lesson_id IS NOT NULL AND subscription_id IS NULL AND period_key IS NULL`,trial/paid 分支加 `lesson_id IS NULL`。
- 唯一部分索引 `(lesson_id) WHERE kind='adjustment'`。
- 新触发器 `usage_reservation_kind_guard`(BEFORE INSERT):job=generate → bucket 必须是 trial/paid;job=adjust → bucket 必须是同一 lesson 的 adjustment bucket。
- 漂移视图与 `releaseReservation` 不用改。

**兼容性**:新列都有默认值或可空;既有行 `origin='generate'`;CHECK 只放宽或只约束新行。既有测试 `schema.test.ts:333-361` 与 `lesson-request-v2.test.ts:820-826` 播种的是 `origin='generate'` 的草稿,含义不变。`lesson_current_revision_guard` 对既有数据成立:生成只设 finalized(`settlement.ts:129,142`);测试 `lesson-request-v2.test.ts:814` 设置的也是 finalized。**需核实**:其它测试是否把 current 指向非 finalized 修订(Task 11 Step 1 先 grep)。E2E 不触及新列。

### 2.2 纯核心

```ts
// src/lib/domain/adjustment.ts
export const ADJUST_OPERATION = "adjust";
export const ADJUSTMENT_REQUEST_VERSION = 1;
export const TextEditTarget = z.discriminatedUnion("field", [
  z.strictObject({ field: z.literal("title") }),
  z.strictObject({ field: z.literal("block_text"), blockIndex: z.number().int().min(0).max(59) }),
  z.strictObject({ field: z.literal("block_item"), blockIndex: z.number().int().min(0).max(59), itemIndex: z.number().int().min(0).max(19) }),
]);
export const TextEdit = z.strictObject({ sectionId: z.string().min(1).max(200), target: TextEditTarget, text: z.string().min(1).max(600) });
export const AdjustmentChange = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("make_easier") }),
  z.strictObject({ action: z.literal("make_harder") }),
  z.strictObject({ action: z.literal("add_exercises"), count: z.number().int().min(1).max(6) }),
  z.strictObject({ action: z.literal("add_worked_example") }),
  z.strictObject({ action: z.literal("change_duration"), durationMinutes: z.number().int().min(15).max(180) }),
  z.strictObject({ action: z.literal("correct_text"), edits: z.array(TextEdit).min(1).max(20) }),
  z.strictObject({ action: z.literal("reduce_theory") }), // llm; rejected at enqueue unless enabled (S4/S6)
]);
export type AdjustmentChange = z.infer<typeof AdjustmentChange>;
export const AdjustmentRequest = z.strictObject({ requestVersion: z.literal(1), sourceRevisionId: z.uuid(), change: AdjustmentChange });
export type AdjustmentMethod = "deterministic" | "llm";
export function methodOf(change: AdjustmentChange): AdjustmentMethod; // reduce_theory -> "llm", else "deterministic"
```

**v1 动作与规则**:

| 动作 | 方法 | regenerate | rehash | 其它 | 不适用的条件 |
|---|---|---|---|---|---|
| make_easier / make_harder | 确定性 | exercises(同题数,难度降/升一级,新种子)+ solutions(derives) | — | 页眉难度经 `effectiveSettings` 改变 | 已是 basic / challenge,或能力表不支持 |
| add_exercises(count 1–6) | 确定性 | exercises(既有题块逐字节保留,追加新题与书写空间)+ solutions(既有解答逐字节保留,追加) | — | 提纲不变(课时不变) | 题数超过 `MAX_EXERCISES=20`(块上限 60:`1+2n≤60`) |
| add_worked_example | 确定性 | worked_examples(在最后一道唯一解例题之后插入) | — | 提纲不变 | 唯一解例题已达 `MAX_EXAMPLES=4` |
| change_duration | 确定性 | teaching_sequence(只换 timing 块)、exercises+solutions(题数变化时整套重抽)、worked_examples(例题数变化时重抽题块,保留引言段落) | 提纲分钟数改变但未重生成的节:explanation 总是(分钟变化时)、worked_examples(未重抽时)、exercises(题数未变时);solutions 分钟恒为 0 且上游 contentHash 未变,保持 unchanged | `outline` 按 `planOutline(新课时)` 重算 | 与当前课时相同。题数/例题数是否变化 = 包内**实际**唯一解例题数/练习题数与 `planOutline(新课时)` 的比较;因此用 add_exercises/add_worked_example 追加过的内容会在题数不同的新课时下被丢弃并重抽(需产品负责人确认这是预期行为) |
| correct_text | tutor_edit | 被编辑的节(method→`tutor_edit`,`edited:true`) | references 下游;derives 下游重新派生后与原内容比较(题目不变时解答逐字节相同) | — | 编辑目标不可编辑 |
| reduce_theory(推迟,S6) | llm | explanation、derivation | worked_examples(ref) | — | LLM 动作未启用 |

```ts
// src/lib/package/adjust.ts
export type Disposition = "unchanged" | "rehash" | "regenerate";
export interface AdjustmentPlan {
  action: AdjustmentChange["action"];
  method: AdjustmentMethod;
  sections: { id: string; disposition: Disposition; method: "deterministic" | "llm" | "tutor_edit" | null }[]; // pkg order
  changed: string[]; dependents: string[]; rehashed: string[]; unchanged: string[];
  outlineChanged: boolean;
}
export const MAX_EXERCISES = 20;
export const MAX_EXAMPLES = 4;
export function planAdjustment(pkg: LessonPackage, change: AdjustmentChange): AdjustmentPlan; // throws AdjustmentNotApplicable(reason)
export function derivesClosure(pkg: Pick<LessonPackage, "deps">, ids: readonly string[]): string[];
export function referencesDownstream(pkg: Pick<LessonPackage, "deps">, ids: readonly string[]): string[];
export function adjustmentSeed(pkg: LessonPackage, sourceContentHash: string, change: AdjustmentChange): string;
// = `${pkg.seed}:adj:${sha256Hex(canonicalJson({ source: sourceContentHash, change })).slice(0, 16)}`
export function applyAdjustment(pkg: LessonPackage, change: Exclude<AdjustmentChange, { action: "correct_text" | "reduce_theory" }>, opts: { seed: string; context: CurriculumContext }): LessonPackage;
// src/lib/package/correct.ts
export function checkCorrections(pkg: LessonPackage, edits: readonly TextEdit[], context: CurriculumContext): { ok: true } | { ok: false; issues: Issue[] };
export function applyCorrections(pkg: LessonPackage, edits: readonly TextEdit[], context: CurriculumContext): LessonPackage; // throws CorrectionRejected
// src/lib/package/inputs.ts  (shared by validator and adjuster; builder unchanged)
export function expectedInputsHash(pkg: LessonPackage, section: Section, request: LessonRequestV2, context: CurriculumContext): string | null;
export function rehashPackage(pkg: LessonPackage, request: LessonRequestV2, context: CurriculumContext): LessonPackage; // recompute contentHash + inputsHash in EDGES order
// src/lib/package/effective.ts
export function effectiveSettings(pkg: LessonPackage): { difficulty: "basic" | "mixed" | "challenge"; durationMinutes: number };
```

**确定性与种子**:
- 种子由"源修订的 contentHash + 规范化的 change"派生,所以同一作业的重试结果逐字节相同。不同源产生不同种子。
- 新题必须避开**源**里所有例题与练习的指纹:`generateExerciseSet` 新增 `exclude`。若有冲突,按 `${seed}:exercises:${attempt}` 递增最多 20 次,仍失败则 `AdjustmentNotApplicable("no_distinct_questions")`。
- 被重生成的节写入 `provenance.seed` 与 `provenance.difficulty`;`pkg.adjustments` 追加 `{ action, method, seed?, sourceContentHash }`(只记动作码,不记更正文字)。

**源课包 `request` 字段保持不变**(它是原始请求快照,lesson.input_spec 也不可变),有效设置从提纲与溯源推导。

### 2.3 "无关节逐字节相同"的精确定义(属性测试的断言)

对任意计划 P 与结果 R:
- 每个 `unchanged` 节:`canonicalJson(R.section) === canonicalJson(source.section)`。
- 每个 `rehash` 节:`kind`、`title`、`blocks`、`contentHash`、`provenance`、`edited` 都相同。
- `documents`、`deps`、`request`、`context`、`seed` 都相同;`outline` 只在 `outlineChanged` 时变。
- 并且 `validatePackage(R).overall === "verified"`。

### 2.4 执行

- **入队**(Web 事务,`createAdjustment`):
  1. 解析请求与幂等键。
  2. 锁 profile(active)。
  3. 幂等(operation `adjust`,hash = `requestHash("adjust", 1, {lessonId, ...request})`):同键同请求返回原作业;同键不同请求冲突。
  4. 锁 lesson `FOR UPDATE`(本人、未删除、`request_version=2`)。
  5. 头修订必须等于 `sourceRevisionId`,否则 `SourceSuperseded`。
  6. 读取源 content,用 `PackageSchema` 解析(schemaVersion 2,否则 NotFound),在 Web 进程里运行 `planAdjustment`,或对更正运行 `checkCorrections`。不适用的请求立即拒绝,不入队。
  7. 限流:`adj:u:h`、`adj:u:d`、`adj:ip:h`(`bumpRateLimit` 支持 hour/day)。
  8. 本课包无活跃调整作业(否则 `AdjustmentInProgress`);本用户活跃调整作业不超过上限;全局积压。
  9. (S4)LLM:检查开关 → 确保 bucket → 锁 → 条件自增 `reserved`。
  10. 建 job:`kind='adjust'`,确定性动作的预算为 0。
  11. (LLM)建预留;回填幂等记录的资源 id。
- **领取**:`claimNext` 改为 `kind IN ('generate','adjust')`,并返回 kind。
- **worker `runAdjustment`**:
  1. 检查点 generating;`getAdjustmentInput`(fenced),读源 content/hash、adjustment、input_spec。
  2. 重新 `planAdjustment`(源不可变,结果与入队时一致),然后 apply/correct。
  3. 检查点 validating;`validatePackage` 必须是 verified,否则 `validation_failed`(不可重试)。
  4. 检查点 compiling;复用抽出的 `renderCompileStore`:渲染**全部所请求文档**,在沙箱编译,只有 `sandbox_unavailable` 可重试。
  5. 检查点 storing;写入 `{owner}/{lesson}/{newRevisionId}/{attemptId}/{doc}.{pdf|tex}` 并回读校验。
  6. `commitAdjustment`。
  7. 失败时尽力删除自己的 attempt 前缀(沿用 `withAttemptCleanup`)。
- **未变 PDF 能否复用**:v1 **全部重编译**。原因:
  - 清单规则要求所有路径都在本 attempt 前缀下(`manifest.ts:99`),跨修订引用会破坏它。
  - `ObjectStore` 没有 copy 操作(`src/lib/storage/store.ts:11-16`)。
  - notes/solutions 页眉含难度与课时,难度调整后这两份本来就会变。
  - 每次最多 3 次编译,成本有界。

  后续优化(不在 M6):给 `ObjectStore` 加 `copy`;当渲染出的 `.tex` 的 sha256 等于源清单里该文档的 `tex.sha256` 时,复制 PDF 到新前缀并回读校验。这样保持清单不变量。
- **`commitAdjustment`**(一个事务):
  1. 锁 job:state=running、token 相同、未请求取消、kind=adjust;同一 attempt 已成功时幂等返回。
  2. 锁 lesson `FOR UPDATE`(未删除),profile `FOR SHARE`(active)。
  3. 头修订等于 `job.source_revision_id`,否则 `StaleOrCanceled` → `finishJob(failed, source_superseded)`(释放)。
  4. 要求 verified;清单完整(文档集合取自 `lesson.input_spec`,复用 `storedRequestedDocuments`)。
  5. 若源是打开的草稿,将其置为 rejected(被取代)。
  6. 插入新修订:`status='draft'`,origin 为 adjust 或 correct,`source_revision_id`,`base_revision_id`(源是 finalized 则取源,否则取源的 base),带清单。
  7. LLM:消耗预留,无预留即 `InvariantViolation` 回滚;确定性:必须**没有**预留。
  8. job=succeeded,`revision_id` = 新草稿。**不**改 current。
- **取消**:复用 `generation.cancelJob`(与种类无关)。

### 2.5 计费与限额(D-33 方案 B)

- **确定性调整与更正**:不是生成,不碰任何 bucket,作业预算为 0。限额(开发默认,标 `TEST VALUE`,D-19):

  | 限额 | 值 |
  |---|---|
  | 每用户每小时 | 30 |
  | 每用户每天 | 150 |
  | 每 IP 每小时 | 60 |
  | 每课包同时活跃 | 1 |
  | 每用户同时活跃调整 | 2 |
  | 作业 maxAttempts | 3 |
  | 作业 deadline | 10 分钟 |

  限流计数随作业一起提交,失败不退(与 `generation.ts:163` 一致)。
- `createGeneration` 的活跃数改为只数 `kind='generate'`(`generation.ts:166`)。M6 之前两者等价,M6 之后调整不会挡住新生成。全局积压继续共享。
- **LLM 调整额度**:
  - 存储:`usage_bucket(kind='adjustment', lesson_id)`,在首次 LLM 调整入队时 `INSERT … ON CONFLICT DO NOTHING` 创建,`limit_count` = 当时的配置值,之后不随配置变化。
  - 预留、消耗、释放与生成完全同构,复用 `releaseReservation`/`finishLockedJob`/扫描器。
  - 配置键(Web):`ADJUSTMENT_LLM_ACTIONS=0|1`(默认 0)与 `ADJUSTMENT_LLM_BUDGET_PER_LESSON`(整数 0–50,默认 **5**,`TEST VALUE`)。
  - worker 侧:`LESSON_PROSE=llm` 且 `LLM_PROVIDER≠fake`(生产)才执行,否则以 `llm_unavailable` 不可重试失败并释放。
  - 作业预算:maxCalls 2(一次加一次修复)、maxTokens 20,000、maxCostMicros 100,000。
  - 推荐默认 5 的理由:D-42 记录的整份文稿调用约 7,400–10,500 微单位/次(`docs/decisions.md` §8.1,单价是**用户配置值**,未与官方价目核对);缩短讲解只重写两节,单次更小。所以每课包最坏约 5 万微单位,而且可以随时调整配置。
- **丢弃草稿不退还**已消耗的 LLM 额度(与"删除不退"一致,CLAUDE.md §5)。

### 2.6 极小更正

- **可编辑**:
  - 除 alignment 外所有节的 `title`。
  - `paragraph`/`note` 的 `text`,适用于 explanation、worked_examples、common_mistakes、exercises、solutions、teaching_sequence,以及 objectives/prerequisites 的引导段落。
  - `list` 项:explanation、teaching_sequence、common_mistakes(**不含** objectives/prerequisites 的数据集列表)。
  - `step_list` 项:derivation。
- **不可编辑**:`question`、`worked_example`、`solution`、`writing_space`、`timing`、`alignment`;不能增删块或列表项。
- **校验**:
  - 先 NFC 规范化,并把空白折叠成单个空格。
  - `checkText`:禁止数字与数学符号、URL/域名、HTML/LaTeX 字符、课程词与课程名、元指令、非常规字符。
  - 长度:标题 1–120,文字 1–600。
  - 与原文相同的编辑视为无操作;全部是无操作的请求被拒绝(`nothing_changed`)。
- **结果**:被编辑节 `provenance.method='tutor_edit'`、`edited:true`,保留 seed/generatorVersion/difficulty;`inputsHash` 按非 LLM 参数重算。产生新草稿(origin `correct`),重新渲染与编译;不是生成,共享调整限额。
- 校验器新增:对所有非 alignment 节的标题运行 `checkText`。alignment 的固定标题 "Curriculum information" 会命中 `CLAIM_WORDS`(`prose-rules.ts:35`),它不可编辑,所以排除。
- **可用性代价**:导师不能输入任何数字,包括 "step two" 这类数量短语(`prose-rules.ts:8,20-29`)。
- **S1 已实现的更正文字规则**(`src/lib/package/correct.ts` 的 `correctionTextProblems`,2026-10-21;问题只返回代码,从不返回文字):
  - **规范化**:NFC;弯引号 ‘ ’ “ ” 转成直引号 `'` 与 `"`;所有空白(制表、换行、NBSP 等)折叠成一个空格并去掉首尾。零宽与双向控制字符不算空白,保留下来由字符检查拒绝。
  - **字符**:沿用 `checkText`:禁止任何数字与数学/标记字符(`= $ \ < > { } ^ _ ~ |`),只允许字母、组合标记、空格与 `. , ; : ' " ( ) ! ? - – —`;所以 `&`、`/`、`%` 一律被拒绝(`PROSE_UNUSUAL_CHARACTERS`)。
  - **数字词(`number_word`)**,集合由代码生成而非手写:
    - 词干 `zero`、`two`..`nineteen`、`twenty`..`ninety`、`hundred`、`thousand`、`million`、`billion`、`trillion`、`dozen`、`myriad`、`googol`,各自本身以及加后缀 `s`/`es`/`th`/`ths`/`fold`/`folds`/`some`/`ish`;以 y 结尾的词干再加 `ieth`/`ieths`/`ies`(`twentieth`、`nineties`)。
    - 不规则词:`fifth(s)`、`eighth(s)`、`ninth(s)`、`twelfth(s)`、`third(s)`、`half`/`halves`/`halve`/`halved`/`halving`、`quarter(s)`/`quartered`、`twice`、`thrice`、`double`..`decuple`(及 `-s`、`-d`)、`doubling`、`tripling`、`single`、`couple(s)`、`pair(s)`、`duo`、`trio`、`quartet`、`quintet`、`sextet`、`octet`(及复数)、`twain`、`decade(s)`、`century`/`centuries`、`nought(s)`、`naught`、`nil`。
    - 由两个及以上数字词(含 `one`)**整词拼接**而成的词(`twentyone`、`sevenhundred`);按整词切分判断,不按子串,所以 `often`、`stone`、`money`、`none` 不受影响。连字符或空格分开的(`twenty-one`)按单词逐个命中。
    - 全大写、至少 2 个字母且是合法罗马数字的词(`II`、`XIX`、`MMXXVI`;也会命中 `MIX`)。`I`、`DIM`、`CIVIC` 不是罗马数字,放行。
    - `one` 只允许出现在白名单里:紧跟在 `no`/`each`/`this`/`that`/`which`/`any`/`every` 之后;紧接在 `of`/`way`/`another`/`side`/`at a time` 之前;以及 `one by one`。其余的 `one` 一律拒绝;另有一层"作为运算数或值"的正则作为第二道网。
    - 明确放行:`first`、`second`、`next`、`last`、`once`、`score`、`gross`、`brace`,以及只是包含数字词的词(`someone`、`thirdly`、`halfway`、`doubly`)。
  - **仅对导师输入的三条规则**(生成文字不受影响):`url_like`(字母后紧跟冒号再接字母或 `/`,如 `javascript:alert`、`mailto:x`);`word_too_long`(按空白与各种横线切分后任一词超过 40 个字符);`unprintable_characters`(LaTeX 渲染器会打印成 "?" 的字母或标记:其他文字系统、残留的组合标记)。
  - **`compatibility_characters`**:文字经 NFKC 后会变化即拒绝(全角字母、`Ĳ` 这类合字、上标)。
  - **课程名骨架规则**(`PROSE_NAMES_CURRICULUM`):把文字与课程名、版本标签、代码以及对齐节标题都化成"骨架"——小写、去重音(NFD 去组合标记)、按折叠表把 `ı ø ł đ ð æ œ ß þ ŋ ħ ŧ ſ ƒ` 换成相近的拉丁字母、只保留字母与数字;文字骨架包含任一长度 ≥ 4 的名称骨架即拒绝。短于 4 的名称骨架被跳过(否则会命中普通词)。
  - **请求级规则**:同一目标出现两次为 `duplicate_target`;全部编辑都是无操作则为 `nothing_changed`。
  - **导师因此失去的说法(已接受的代价,见 D-69 第 3 项)**:`work in pairs`、`a single step`、`double check`、`half`、`decade`、`trio`、`the right one`、`pick one example`、`more than one method`,以及恰好构成罗马数字的大写词 `MIX`、`XL`、`CD`、`MD`、`DC`、`CM`、`MM`。
  - **建议(数据集校验器,尚未实现)**:当课程名、版本标签或代码化成骨架后少于 6 个字母/数字,或本身是常见英文单词时给出警告;这类名称会让骨架规则误伤普通文字,或因短于 4 被跳过而失去保护。

### 2.7 Web 接口(U6 需要的后端)

```ts
// src/lib/server/dal/adjustments.ts  (web, app_runtime)
export interface AdjustmentDeps { limits?: AdjustmentLimits; clock?: () => Date }
export function createAdjustmentDal(db: Db, deps?: AdjustmentDeps): {
  createAdjustment(ctx: AuthedCtx, lessonId: string, rawRequest: unknown, rawIdempotencyKey: string, options?: { ipHash?: string }): Promise<{ job: JobDto; replayed: boolean }>;
  acceptDraft(ctx: AuthedCtx, lessonId: string, draftRevisionId: string): Promise<{ revisionId: string; replayed: boolean }>;
  discardDraft(ctx: AuthedCtx, lessonId: string, draftRevisionId: string): Promise<{ replayed: boolean }>;
  getAdjustmentState(ctx: AuthedCtx, lessonId: string): Promise<AdjustmentStateView>;
};
export interface AdjustmentStateView {
  lessonId: string;
  currentRevisionId: string;
  headRevisionId: string;
  draft: { revisionId: string; number: number; createdAt: Date; baseRevisionId: string; changes: { action: AdjustmentChange["action"] }[] } | null;
  activeJob: JobDto | null;
  actions: { action: AdjustmentChange["action"]; method: AdjustmentMethod; available: boolean; reason: null | "at_easiest" | "at_hardest" | "max_exercises" | "max_examples" | "same_duration" | "llm_disabled" | "budget_exhausted" | "in_progress" | "legacy_lesson" }[];
  llmBudget: { limit: number; used: number; pending: number; remaining: number } | null; // null when LLM actions are disabled
  editable: { sectionId: string; title: boolean; blocks: { blockIndex: number; field: "block_text" | "block_item"; items?: number }[] }[];
}
```

- `lessons.getLessonView` / `getLessonPackage` / `getArtifact` 接受打开的调整草稿作为 `rev`(条件:`status='draft' AND origin<>'generate' AND artifact_manifest IS NOT NULL`)。`LessonView` 新增 `status: "current" | "earlier" | "draft"`。rejected 与 origin=generate 的草稿仍是 NotFound(D-51 修订)。
- `JobDto.kind` 增加 `"adjust"`(`dto.ts:7`);`/api/jobs/[id]` 不改即可轮询;作业页成功后跳转 `?rev=<草稿>`(`jobs/[id]/page.tsx:20-28` 已经是这样,前提是 getLessonView 接受草稿)。
- Server Actions(`src/app/lessons/[id]/actions.ts`):`requestAdjustmentAction`、`submitCorrectionsAction`、`acceptDraftAction`、`discardDraftAction`;取消复用 `cancelJobAction`。每个 action 内部都调用 `requireAccount()`,id 用 zod 的 uuid 校验。

### 2.8 安全

**授权矩阵**(每格的期望;"他人" = 另一已验证用户):

| 操作 | 本人 | 他人 | 课包已删除 | 账户 deleting | 伪造或非 uuid id |
|---|---|---|---|---|---|
| createAdjustment | 成功 | NotFound,不写任何行(包括限流计数与幂等键:先校验 lesson 归属,再插入幂等键;注意与 createGeneration 的顺序不同,见 Task 14) | NotFound | AccountNotActive | NotFound |
| acceptDraft / discardDraft | 成功,幂等 | NotFound,不变 | NotFound | AccountNotActive | NotFound |
| getAdjustmentState / 草稿视图 / 草稿 PDF | 成功 | NotFound | NotFound | 路由返回 404 | NotFound |
| cancelJob(adjust) | 成功 | NotFound | — | — | NotFound |
| worker commitAdjustment | — | 不适用(job 的 owner 来自行) | StaleOrCanceled → 失败释放 | StaleOrCanceled | — |

- **模型无工具**;LLM 动作(S6)的输入是已通过 prose 规则的节文字。其中可能有导师编辑过的文字,即用户输入,因此作为 JSON 数据字段传入,系统提示固定。输出必须过 schema、`checkText`(含 `META_TEXT`)与长度检查,不合格修复一次,仍不合格则作业失败并释放额度。模型输出永远不会成为数学内容。
- **新对象路径**沿用 `{owner}/{lesson}/{revision}/{attempt}/…`,Storage RLS 不变。草稿 PDF 本人可读,是否可访问由应用路由按状态决定。丢弃的草稿对象保留到课包删除(孤儿对账见 P3)。
- **日志**:`adjust_enqueued`、`adjust_committed`、`draft_accepted`、`draft_discarded` 只记 jobId、lessonId、action、method、错误码与耗时;**不记**编辑文字与课包内容。

### 2.9 测试计划(CLAUDE.md §11)

| 层 | 内容 | 命令 / 需要 Docker? |
|---|---|---|
| 单元 | 计划器每个动作的分类;derives 与 references 闭包;种子派生与重试确定性;不适用的边界;更正可编辑矩阵与对抗文本(`<script>`、`\input`、URL、数字、课程名、"ignore previous instructions");`effectiveSettings`;未调整课包的渲染与 HTML 输出逐字节不变 | `pnpm test`,不需要 |
| 属性(种子化循环) | 对 N=200 个种子与随机长度 1–6 的动作序列:每步结果都是 verified;练习与解答 id 一一对应且答案正确;§2.3 的逐字节断言;新题指纹与源不重叠;worksheet 视图无解答 | `pnpm test`,不需要 |
| 集成(真实 Postgres) | 迁移与触发器(草稿带清单只限调整来源、一个打开草稿、草稿不能成为 current、调整修订不可变、预留种类守卫);并发入队同一课包只成功一个;同键重放与冲突;接受/丢弃竞争与重放;LLM 额度最后一单位的竞争;失败、取消、超时释放;旧 worker 晚到提交被拒且不消耗;跨用户矩阵;生成的 3 次额度在任意调整序列后不变;`usage_bucket_drift` 为空 | `pnpm test:integration`,**需要 Docker** |
| worker / 流水线 | 假 LLM + `SkeletonDocumentCompiler`:端到端调整与更正;编译失败、沙箱暂时不可用后重试成功、存储失败后清理前缀、取消、失租、源被取代 | `pnpm test:integration`,需要 Docker |
| 真实编译 | 调整后的课包经真实镜像编译出三份 PDF;worksheet 文本不含答案;页眉显示有效难度与课时 | `pnpm test:latex`,**需要 Docker 与 LaTeX 镜像** |
| Storage | 草稿 PDF 本人签名可读,他人不可读;`.tex` 不可读 | `pnpm test:supabase`,需要 Supabase 本地栈 |
| E2E(随 U6) | 打开课包 → 更难 → 进度 → 草稿横幅 → 预览草稿 PDF 与 HTML → 接受 → 版本徽章;丢弃;更正抽屉;刷新与后退不重复入队;手改 `rev` 访问他人草稿得到 404 | `pnpm test:e2e`,需要 Docker 与 Supabase |

### 2.10 切片

| 切片 | 目标 | 验收 | 风险 | 回滚 | 解锁 U6 |
|---|---|---|---|---|---|
| **S1 纯核心** | 计划器、执行器、更正、种子、校验器按节溯源、有效设置 | 单元与属性测试通过;`buildPackage` 输出与渲染输出对既有输入逐字节不变;旧课包 fixture 仍 verified | 校验器改动波及既有包(由回归 fixture 控制) | 回退提交;没有数据变化 | 可用 fixture 做 U6 的 HTML 前后对比原型 |
| **S2 草稿持久化** | 迁移、Prisma、草稿读取、接受/丢弃 DAL | 迁移可重复执行;触发器测试;所有权测试(只加不减) | 枚举追加不易回滚 | 新列可空、可删;`adjust` 枚举值留着无害 | 草稿横幅、接受/丢弃按钮、版本标签(可用播种的草稿开发) |
| **S3 确定性执行** | 入队、领取、worker、提交、Server Actions、限额 | 端到端调整成功;失败不改源;并发与幂等;生成额度不变 | worker 的抽取式重构 | 关掉 Server Action 入口;worker 忽略 adjust(把领取条件改回) | 调整面板与进度 |
| **S5 更正** | `correct_text` 接入 S3 | 对抗文本被拒;tutor_edit 溯源;无关节逐字节相同 | 数字禁令的可用性 | 隐藏更正入口 | 更正抽屉 |
| **S4 LLM 额度 + reduce_theory(= S6)** | adjustment bucket、预留守卫、一次结算、第一个 LLM 动作(默认关闭) | 计费不变量集成测试;受控真实评估记录(同 D-42) | 成本与文字质量 | `ADJUSTMENT_LLM_ACTIONS=0` | LLM 动作显示与剩余额度 |

顺序:S1 → S2 → S3 → S5 → S4。之后再做:expand_steps(新的可验证步骤类型)、focus_objective(目标到题型的映射)、复用未变化的 PDF。

---

## Tasks

### S1 — 纯核心(分支 `feat/m6-core`)

### Task 1: 有效设置与页眉

**Files:**
- Create: `src/lib/package/effective.ts`、`tests/unit/package-effective.test.ts`
- Modify: `src/lib/latex/render.ts`(`:91-100`)、`src/lib/package/html-view.ts`(`:122-127`)

**Interfaces:**
- Produces: `effectiveSettings(pkg: LessonPackage): { difficulty: "basic"|"mixed"|"challenge"; durationMinutes: number }`。难度 = exercises 节的 `provenance.difficulty ?? request.difficulty`;课时 = `outline.totalMinutes`。

- [ ] **Step 1: 写失败测试**:对 `buildPackage(testRequest(...))`(`tests/fixtures/package.ts`)的三种难度 × 课时 45/60/90,断言 `effectiveSettings` 等于请求;断言 `renderDocument` 与 `htmlDocument` 的输出与改动前的快照哈希相同(先在旧代码上算出 sha256 写进测试);构造 exercises 带 `provenance.difficulty:"challenge"`、`outline.totalMinutes:90` 的包,断言页眉显示 "90 minutes" 与 "Challenge"。
- [ ] **Step 2: 运行** `pnpm exec vitest run tests/unit/package-effective.test.ts`,预期 FAIL(模块不存在)。
- [ ] **Step 3: 实现**:页眉改读 `effectiveSettings(pkg)`;`difficulty` 读取依赖 Task 2 的 schema 字段,本任务先用 `(section.provenance as {difficulty?})`。
- [ ] **Step 4: 运行** `pnpm test`、`pnpm lint`、`pnpm typecheck`。
- [ ] **Step 5: 提交** `git add` 上述 4 个路径;`git commit -m "package: derive header difficulty and duration from the package itself"`。

### Task 2: schema 追加字段与按节溯源的校验

**Files:**
- Create: `src/lib/package/inputs.ts`、`tests/unit/package-inputs.test.ts`、`tests/fixtures/stored-package-v1.json`(由当前 `buildPackage` 生成并冻结的 fixture)
- Modify: `src/lib/package/schema.ts`(`:62-68`、`:125-139`)、`src/lib/package/validate.ts`(`:34-43`、`:130-153`、`PACKAGE_VALIDATOR_VERSION`)

**Interfaces:**
- `provenance` 增加 `difficulty: z.enum(["basic","mixed","challenge"]).optional()`。
- `PackageSchema` 增加 `adjustments: z.array(z.strictObject({ action: z.string().max(40), method: z.enum(["deterministic","llm","tutor_edit"]), seed: z.string().max(200).optional(), sourceContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/) })).max(200).optional()`。
- `expectedInputsHash(pkg, section, request, context): string | null`(从 `validate.ts:136-152` 抽出,改用 `section.provenance.seed ?? pkg.seed` 与 `section.provenance.difficulty ?? request.difficulty`);`rehashPackage(pkg, request, context): LessonPackage`。
- `PACKAGE_VALIDATOR_VERSION` 改为 `package/2+${VALIDATOR_VERSION}`。

- [ ] **Step 1: 写失败测试**:
  - 冻结 fixture 仍为 verified。
  - 对所有内置构建,每节 `expectedInputsHash === section.inputsHash`。
  - 只改 exercises 的种子与难度并 `rehashPackage` 后仍为 verified;不 rehash 则报 `INPUTS_HASH_MISMATCH`。
  - 非 alignment 节的标题含 "curriculum"、数字或 `<b>` 时报 prose 违规;alignment 标题 "Curriculum information" 不报。
  - `buildPackage` 的输出 JSON 与旧 fixture 逐字节相同(构建器不得变)。
- [ ] **Step 2: 运行**,确认 FAIL。
- [ ] **Step 3: 实现**:checkProse 增加标题检查(排除 alignment)。
- [ ] **Step 4: 运行** `pnpm test`(包括既有的 `tests/unit/package.test.ts`、`prose.test.ts`,断言不改)、`pnpm typecheck`。
- [ ] **Step 5: 提交** `git commit -m "package: per-section provenance for inputs hashes; check section titles"`。

### Task 3: 调整请求类型与领域错误

**Files:**
- Create: `src/lib/domain/adjustment.ts`、`tests/unit/adjustment-request.test.ts`
- Modify: `src/lib/domain/errors.ts`

**Interfaces:**
- §2.2 的 `AdjustmentChange`、`AdjustmentRequest`、`TextEdit`、`methodOf`。
- `AdjustmentLimits` 与 `DEV_DEFAULT_ADJUSTMENT_LIMITS`:`{ ratePerHourPerUser:30, ratePerDayPerUser:150, ratePerHourPerIp:60, maxActivePerUser:2, job:{ maxAttempts:3, deadlineMinutes:10 }, llm:{ enabled:false, budgetPerLesson:5, job:{ maxCalls:2, maxTokens:20_000, maxCostMicros:100_000 } } }`,注释标 `TEST VALUE`。
- 错误(各带稳定 code):`AdjustmentNotApplicable(reason)` → `ADJUSTMENT_NOT_APPLICABLE`;`SourceSuperseded` → `SOURCE_SUPERSEDED`;`AdjustmentInProgress` → `ADJUSTMENT_IN_PROGRESS`;`AdjustmentBudgetExhausted` → `ADJUSTMENT_BUDGET_EXHAUSTED`;`AdjustmentUnavailable` → `ADJUSTMENT_UNAVAILABLE`;`CorrectionRejected(codes: string[])` → `CORRECTION_REJECTED`。错误消息不含内容。

- [ ] **Step 1: 写失败测试**:未知动作、多余键、count 0 与 7、课时 14 与 181、edits 0 与 21、文本 601 字符、非 uuid 的源都被拒;`methodOf` 的映射;`domainErrorCode` 能识别新错误。
- [ ] **Step 2–4:** 运行确认失败 → 实现 → `pnpm test`、`pnpm typecheck`。
- [ ] **Step 5: 提交** `git commit -m "domain: adjustment request schema, limits and errors"`。

### Task 4: `planAdjustment`

**Files:**
- Create: `src/lib/package/adjust.ts`(计划部分)、`tests/unit/adjust-plan.test.ts`

**Interfaces:** `planAdjustment`、`derivesClosure`、`referencesDownstream`、`MAX_EXERCISES`、`MAX_EXAMPLES`(§2.2)。

- [ ] **Step 1: 写失败测试**(逐动作断言 changed、dependents、rehashed、unchanged 与 method,对照 §2.2 的表):
  - make_harder 在 mixed 上 → changed=[exercises]、dependents=[solutions]、unchanged=其余 8 节。
  - make_easier 在 basic 上抛 `at_easiest`;make_harder 在 challenge 上抛 `at_hardest`。
  - add_worked_example 在 4 道唯一解例题时抛 `max_examples`。
  - change_duration 为相同课时时抛 `same_duration`;60→90 时(题数 6→8,例题数 2→3,取自 `planOutline`;**更正**:原文的 9→12 实为 90→120)exercises、solutions、worked_examples、teaching_sequence 都是 regenerate,sec-explanation 为 rehash(提纲分钟 9→14),且 `outlineChanged=true`。
  - correct_text 编辑 explanation 段落 → changed=[explanation]、rehashed=[worked_examples]。
  - correct_text 编辑 exercises 引导段落 → dependents=[solutions](重新派生,应用后再判定逐字节相同)。
  - 编辑目标为 question 块、objectives 的列表项、alignment、timing 时抛 `not_editable`。
  - reduce_theory 的 method 为 `llm`。
  - 计划器对输入不做任何修改(调用前后 `canonicalJson` 相同)。
- [ ] **Step 2–4:** 确认失败 → 实现(只沿 derives 求重生成闭包,references 下游为 rehash)→ `pnpm test`。
- [ ] **Step 5: 提交** `git commit -m "package: pure adjustment planner with dependency closure"`。

### Task 5: 种子与练习类执行(easier、harder、add_exercises)

**Files:**
- Modify: `src/lib/math/generator.ts`(`generateExerciseSet` 增加可选 `startIndex?: number`、`exclude?: ReadonlySet<string>`;导出 `questionFingerprint(q: { problem: { equation: unknown } }): string`)、`src/lib/package/adjust.ts`
- Test: `tests/unit/adjust-apply.test.ts`、`tests/unit/generator.test.ts`(只追加)

**Interfaces:**
- `adjustmentSeed(pkg, sourceContentHash, change): string`。
- `applyAdjustment(pkg, change, { seed, context }): LessonPackage`:返回值已 `rehashPackage`,并追加 `adjustments` 记录。

- [ ] **Step 1: 写失败测试**:
  - 不传新参数时 `generateExerciseSet` 的输出与旧版逐字节相同。
  - `startIndex: 10` 产生 `ex-10…`;`exclude` 中的指纹不会出现。
  - make_harder:题数不变;每题 `meta` 难度升一级(mixed 的分段规则见下);exercises 的 `provenance.seed` 与 `difficulty` 已写入。
  - add_exercises count=3:前 n 个 question/writing_space 块与源逐字节相同,新增 `ex-(n+1)…(n+3)`;solutions 前 n 个块逐字节相同。
  - 同一输入两次调用结果逐字节相同;不同源的 contentHash 产生不同种子。
  - 新题指纹与源中全部例题、练习都不重叠。
  - 结果为 verified;§2.3 断言成立。
- [ ] **Step 2–4:** 确认失败 → 实现 → `pnpm test`。实现说明:
  - 难度阶梯 basic < mixed < challenge。
  - 追加题使用有效难度;有效难度为 mixed 时追加题直接用 mixed 级,不重排分段。
  - 保留题的解答按 questionId 从源 solutions 复制,新题的解答取自生成器。
- [ ] **Step 5: 提交** `git commit -m "package: deterministic difficulty and exercise-count adjustments"`。

### Task 6: add_worked_example 与 change_duration

**Files:** Modify `src/lib/package/adjust.ts`;Test `tests/unit/adjust-apply.test.ts`(追加)。

- [ ] **Step 1: 写失败测试**:
  - 在 mixed 包(含无解例题与注释)上 add_worked_example:新例题位于最后一道唯一解例题之后、无解例题之前;注释仍是最后一块;id 唯一(取最大 `we-n` 加 1);引言段落逐字节保留。
  - 在 basic 包(无无解例题)上:新例题追加在末尾。
  - change_duration 60→30:提纲各项之和为 30;timing 块与提纲一致;teaching_sequence 的列表块逐字节保留;题数按 `planOutline(30)` 变化;worked_examples 题数变化时引言段落保留。
  - 所有结果为 verified。
- [ ] **Step 2–4:** 确认失败 → 实现 → `pnpm test`。
- [ ] **Step 5: 提交** `git commit -m "package: add worked example and change duration adjustments"`。

### Task 7: 更正(纯函数)

**Files:** Create `src/lib/package/correct.ts`、`tests/unit/correct.test.ts`。

**Interfaces:** `checkCorrections`、`applyCorrections`(§2.2);导出 `EDITABLE_BLOCKS: Readonly<Record<SectionKind, readonly ("paragraph"|"note"|"list"|"step_list")[]>>`。

- [ ] **Step 1: 写失败测试**:
  - 可编辑矩阵全覆盖(§2.6)。
  - 对抗输入逐条被拒并返回对应代码:`<script>alert(x)</script>`、`\input{x}`、`see example.com`、`add seven to both sides`、`7`、`Fiction Edition 7`、`aligned with the curriculum`、`ignore previous instructions`、emoji、超长文本。
  - 与原文相同的编辑为无操作;全部无操作时拒绝 `nothing_changed`。
  - 合法编辑后:该节 `method='tutor_edit'`、`edited:true`,seed/generatorVersion 保留;references 下游只 rehash;编辑 exercises 引导段落后 solutions 块逐字节相同;结果为 verified。
  - 不能通过 blockIndex 越界或指向不可编辑块来改数学。
- [ ] **Step 2–4:** 确认失败 → 实现 → `pnpm test`。
- [ ] **Step 5: 提交** `git commit -m "package: minimal text corrections limited to prose fields"`。

### Task 8: 属性测试

**Files:** Create `tests/unit/adjust-properties.test.ts`。

- [ ] **Step 1: 编写**:用 `new Rng("m6-prop|"+i)`,对 i<200 在 {basic,mixed,challenge}×{30,60,90,120} 上随机选初始请求,再随机施加 1–6 个**适用**的动作(包含 correct_text,文本从合法词库组合)。每步断言:
  - verified。
  - 练习与解答 id 序列相同,每道题经 `validateLinearQuestion` 为 verified。
  - §2.3 的逐字节断言(对照该步的计划)。
  - 新题指纹与上一步全部题目不重叠。
  - `documentView(pkg,"worksheet")` 不含 solution 块。
  - 重放同一序列得到逐字节相同的最终包。
- [ ] **Step 2: 运行** `pnpm test`;运行时长超过 20 秒时把 N 降到 100,并在测试注释里说明。
- [ ] **Step 3: 提交** `git commit -m "test: property checks for adjustment sequences"`。

---

### S2 — 草稿持久化(分支 `feat/m6-drafts`)

### Task 9: 枚举迁移

**Files:** Create `prisma/migrations/<ts>_job_kind_adjust/migration.sql`(只含 `ALTER TYPE "job_kind" ADD VALUE IF NOT EXISTS 'adjust';`);Modify `prisma/schema.prisma`(`:21-26`)。

- [ ] **Step 1:** 写迁移;`pnpm db:generate`;`pnpm typecheck`。
- [ ] **Step 2:** 有 Docker 时 `pnpm db:up && pnpm db:migrate:deploy` 对干净库执行两次(第二次为无操作);否则报告"未运行"。**需核实**:固定的 Prisma 7.x 是否把每个迁移包在事务里。PG17 允许在事务里 ADD VALUE,但新值不能在同一事务使用,所以本迁移只做这一件事。
- [ ] **Step 3: 提交** `git commit -m "db: add the adjust job kind"`。

### Task 10: 调整与草稿迁移

**Files:** Create `prisma/migrations/<ts+1>_lesson_adjustments/migration.sql`;Modify `prisma/schema.prisma`(`LessonRevision` 加 `origin`、`baseRevisionId`;`GenerationJob` 加 `sourceRevisionId`、`adjustment`;对应关系字段)。

**Interfaces(SQL)**:按 §2.1 实现:
- 列与 FK。
- CHECK:`generation_job_adjust_shape`、`lesson_revision_origin_known`、替换后的 `lesson_revision_manifest_only_finalized`、`lesson_revision_adjust_complete`。
- 部分唯一索引 `lesson_revision_one_open_draft`。
- 用 `CREATE OR REPLACE FUNCTION` 更新 `lesson_revision_guard`、`generation_job_guard`、`generation_job_reservation_shape`。
- 新函数与触发器 `lesson_current_revision_guard`。
- 不新增表,所以授权与 RLS 不变(`…constraints_roles_rls/migration.sql:195-222` 已覆盖这些表)。

- [ ] **Step 1:** 写迁移 → `pnpm db:generate` → `pnpm typecheck`。
- [ ] **Step 2: 提交** `git commit -m "db: adjustment drafts, job adjustment columns and guards"`。

### Task 11: 迁移与触发器的集成测试

**Files:** Modify `tests/integration/schema.test.ts`(只追加)、`tests/integration/helpers.ts`(`seedRevision` 增加可选 `origin`、`sourceRevisionId`、`baseRevisionId`)。

- [ ] **Step 1: 先 grep** `current_revision_id` 与 `status: "draft"` 在 `tests/` 中的用法,确认既有测试不违反新守卫(已知:`schema.test.ts:408-411`、`lesson-request-v2.test.ts:814` 指向 finalized)。
- [ ] **Step 2: 写测试**:
  - origin=generate 的草稿带清单仍被拒(原 `:361` 不变)。
  - origin=adjust 的草稿缺清单或为 unverified → 23514。
  - 同课包第二个打开的调整草稿 → 23505。
  - 调整草稿的 content 或清单不可改;draft 只能 → finalized 或 rejected;rejected 与 finalized 不可再改。
  - `current_revision_id` 指向草稿 → 55000。
  - adjust 作业缺 `source_revision_id` → 23514。
  - 确定性 adjust 作业带预留 → 延迟约束失败;llm adjust 作业无预留 → 失败。
  - `origin`、`base_revision_id` 与作业的两列不可变。
- [ ] **Step 3: 运行** `pnpm test:integration`(**需要 Docker**;不可用时报告未运行)。
- [ ] **Step 4: 提交** `git commit -m "test: database guards for adjustment drafts"`。

### Task 12: 草稿读取

**Files:** Modify `src/lib/server/dal/lessons.ts`(`:57-70`、`LessonView`)、`src/lib/server/dal/dto.ts`(`kind` 加 `"adjust"`)、`src/lib/ui/job-view.ts`(`JobView` 加 `kind`);Test `tests/unit/lessons-package-dal.test.ts`(追加)、`tests/integration/lesson-request-v2.test.ts`(追加)。

**Interfaces:**
- 内部 `findViewableRevision(ctx, lessonId, revisionId?)`:接受 finalized,或打开的调整草稿(`status='draft' AND origin IN ('adjust','correct') AND artifact_manifest IS NOT NULL`)。
- `LessonView.status: "current" | "earlier" | "draft"`;`isCurrent` 保留。

- [ ] **Step 1: 写测试**:
  - 本人打开的调整草稿可以查看,包括课包、PDF 引用与 `status:"draft"`。
  - 他人的草稿、rejected 草稿、origin=generate 的草稿都是 NotFound(原 `:820-826` 不变)。
  - 课包已删除时草稿为 NotFound。
- [ ] **Step 2–3:** 实现;`pnpm test`、`pnpm test:integration`(需要 Docker)。
- [ ] **Step 4: 提交** `git commit -m "dal: owners can preview their open adjustment draft"`。

### Task 13: 接受与丢弃

**Files:** Create `src/lib/server/dal/adjustments.ts`(本任务实现 `acceptDraft`、`discardDraft`、`getAdjustmentState` 的只读部分);Modify `src/lib/server/dal/index.ts`(`createWebDal` 增加 `adjustments`)、`tests/integration/ownership.test.ts`(`:47` 的键集合加 `adjustments`,并新增 `adjustments` 键集合断言);Create `tests/integration/adjustments.test.ts`。

**Interfaces:** §2.7 的 `acceptDraft`、`discardDraft`、`getAdjustmentState`。

- [ ] **Step 1: 写测试**(用 admin 播种 finalized 修订、调整草稿与 current):
  - 接受后 current=草稿且 status=finalized;重复接受 → `replayed:true`。
  - 丢弃 → rejected;重复丢弃 → `replayed:true`。
  - 接受与丢弃并发:恰好一个生效,另一个返回 NotFound 或重放,终态一致。
  - 存在 queued 或 running 的 adjust 作业时两者都抛 `AdjustmentInProgress`。
  - `base_revision_id ≠ current` → `SourceSuperseded`。
  - 跨用户:NotFound,且数据不变。
- [ ] **Step 2–3:** 实现(先锁 lesson `FOR UPDATE`,再锁修订);`pnpm test:integration`(需要 Docker)。
- [ ] **Step 4: 提交** `git commit -m "dal: accept or discard an adjustment draft"`。

---

### S3 — 确定性执行(分支 `feat/m6-execute`)

### Task 14: 入队 `createAdjustment`

**Files:** Modify `src/lib/server/dal/adjustments.ts`、`src/lib/server/dal/generation.ts`(`bumpRateLimit` 抽成 `src/lib/server/dal/rate-limit.ts` 并支持 `"hour"|"day"`;`:166` 改为只数 `kind:"generate"`);Test `tests/integration/adjustments.test.ts`。

**Interfaces:**
- `createAdjustment(ctx, lessonId, rawRequest, rawIdempotencyKey, options?)`。
- `bumpRateLimit(tx: Tx, key: string, max: number, window: "hour"|"day"): Promise<void>`。

步骤顺序(与 `createGeneration` 的差别):锁 profile 之后、插入幂等键之前,先用 `SELECT 1 FROM lesson WHERE id AND owner AND deleted_at IS NULL` 校验课包归属。这样他人的 lessonId 不会留下幂等行或限流计数。幂等重放检查仍在头修订检查之前。

- [ ] **Step 1: 写测试**:
  - 成功入队:作业 kind=adjust、预算为 0、无预留;trial bucket 的 used/reserved 不变。
  - 同键同请求返回原作业;同键不同请求抛 `IdempotencyConflict`。
  - 两个并发请求打同一课包:一个成功,另一个 `AdjustmentInProgress`。
  - 源不是头修订 → `SourceSuperseded`;make_easier 在 basic → `AdjustmentNotApplicable`,且不写作业、限流计数与幂等键。
  - v1 课包 → NotFound;他人课包 → NotFound 且无任何写入。
  - 超过小时限流 → `RateLimited`;LLM 动作在默认配置下 → `AdjustmentUnavailable`。
  - 生成路径的既有测试不改即通过(`tests/integration/allowance.test.ts`)。
- [ ] **Step 2–3:** 实现;`pnpm test:integration`(需要 Docker)。
- [ ] **Step 4: 提交** `git commit -m "dal: enqueue deterministic adjustments with idempotency and limits"`。

### Task 15: 领取与输入

**Files:** Modify `src/lib/server/dal/jobs.ts`(`:8-17`、`:63-90`;新增方法);Test `tests/integration/worker.test.ts`(追加)。

**Interfaces:**
- `ClaimedJob.kind: "generate" | "adjust"`。
- `getAdjustmentInput(jobId: string, token: bigint): Promise<{ sourceRevisionId: string; sourceContent: unknown; sourceContentHash: string; adjustment: unknown; inputSpec: unknown }>`:按 token 与 running 过滤,否则抛 `StaleOrCanceled`。

- [ ] **Step 1: 写测试**:两种作业都能领取且各只领一次;compile 作业不被领取;旧 token 读输入抛 `StaleOrCanceled`。
- [ ] **Step 2–3:** 实现;`pnpm test:integration`。
- [ ] **Step 4: 提交** `git commit -m "jobs: claim adjustment jobs and read their fenced input"`。

### Task 16: `commitAdjustment`

**Files:** Modify `src/lib/server/dal/settlement.ts`、`src/lib/server/dal/index.ts`(导出类型);Test `tests/integration/adjustments.test.ts`。

**Interfaces:** `commitAdjustment(input: { jobId: string; fencingToken: bigint; attemptId: string; revisionId: string; origin: "adjust"|"correct"; revision: RevisionDraft; manifest: ManifestV2; requestedDocuments: readonly DocumentKind[] }): Promise<{ revisionId: string; replayed: boolean }>`(§2.4)。

- [ ] **Step 1: 写测试**:
  - 成功:草稿已插入,current 不变,作业 succeeded,无预留变动。
  - 在打开的草稿上叠加:旧草稿变为 rejected,新草稿的 base 等于 current。
  - 旧 token 或已取消 → `StaleOrCanceled`,没有任何写入。
  - 期间头修订被接受或丢弃 → `StaleOrCanceled`(由 worker 转为 `source_superseded` 失败)。
  - unverified → `NotCompleteSuccess`;清单前缀或文档集合不符 → `ManifestIncomplete`。
  - 同一 attempt 重放 → `replayed`。
  - 课包已删除 → `StaleOrCanceled`。
- [ ] **Step 2–3:** 实现;`pnpm test:integration`。
- [ ] **Step 4: 提交** `git commit -m "settlement: commit an adjustment as a draft revision"`。

### Task 17: worker 调整流水线

**Files:**
- Create: `worker/publish.ts`(从 `worker/pipeline.ts:248-316` 抽出 `renderCompileStore`,生成路径改为调用它,行为不变)、`worker/adjust.ts`
- Modify: `worker/pipeline.ts`(`runPipeline` 开头按 `job.kind` 分派)
- Test: `tests/integration/worker.test.ts`、`tests/integration/adjustments.test.ts`(追加)

**Interfaces:**
- `renderCompileStore(args: { job: ClaimedJob; deps: PipelineDeps; pkg: LessonPackage; signal: AbortSignal; checkpoint: (s: Stage) => Promise<void>; commit: (a: { attemptId: string; revisionId: string; manifest: ManifestV2; rendered: RenderedDocument[] }) => Promise<void> }): Promise<void>`。
- `runAdjustment(job: ClaimedJob, deps: PipelineDeps, signal: AbortSignal): Promise<void>`。

- [ ] **Step 1: 基线**:改动前跑 `pnpm test:integration` 的 worker 与 v2 测试并记录结果(需要 Docker)。
- [ ] **Step 2: 抽取** `renderCompileStore`;既有测试不改断言即通过。
- [ ] **Step 3: 写失败测试**(假 LLM + `SkeletonDocumentCompiler`):
  - make_harder 端到端:草稿 verified;三个 PDF 在新修订的前缀下;源修订的 content、hash 与清单不变。
  - 编译失败 → failed,无草稿,前缀已清理。
  - `sandbox_unavailable` 后重试成功;重试结果与一次成功的结果逐字节相同(种子确定)。
  - 存储校验失败 → 重试;取消 → canceled;旧 worker 晚到提交被丢弃。
  - 期间草稿被丢弃 → failed(`source_superseded`)。
  - 确定性作业若调用模型 → `budget_exceeded`(用会调用模型的假实现注入验证)。
- [ ] **Step 4: 实现**;运行 `pnpm test:integration`(需要 Docker)。
- [ ] **Step 5: 提交**(两个提交:先抽取,再新增)`refactor(worker): extract render/compile/store`、`feat(worker): run adjustment jobs`。

### Task 18: Server Actions 与轮询兼容

**Files:** Create `src/app/lessons/[id]/actions.ts`;Modify `src/lib/ui/messages.ts`(新增错误码文案);Test `tests/unit/adjust-actions.test.ts`(纯解析与重定向辅助函数)。

**Interfaces:** `requestAdjustmentAction(formData: FormData): Promise<never>`(字段 `lessonId`、`sourceRevisionId`、`key`、`action`、参数)→ 重定向 `/jobs/{id}`;`acceptDraftAction`、`discardDraftAction` → 重定向 `/lessons/{id}?rev=…`。每个 action 内部都调用 `requireAccount()`;错误用 `domainErrorCode` 判断(D-29)。

- [ ] **Step 1–3:** 先写测试 → 实现 → `pnpm test`、`pnpm build`。
- [ ] **Step 4: 提交** `git commit -m "app: server actions for adjustments and drafts"`。

### Task 19: 真实编译路径

**Files:** Modify `tests/latex/pipeline.test.ts`(追加)。

- [ ] **Step 1:** 追加用例:make_harder 与 add_worked_example 后的课包经真实镜像编译;三份 PDF 有效;worksheet 文本无答案;notes 页眉为有效难度。
- [ ] **Step 2:** `pnpm test:latex`(**需要 Docker 与镜像**;不可用时报告未运行)。
- [ ] **Step 3: 提交** `git commit -m "test(latex): compile adjusted packages in the sandbox image"`。

---

### S5 — 更正接入(分支 `feat/m6-corrections`)

### Task 20a: 更正入队与执行

**Files:** Modify `src/lib/server/dal/adjustments.ts`(`correct_text` 走 `checkCorrections`)、`worker/adjust.ts`(调用 `applyCorrections`,origin 为 `correct`)、`src/app/lessons/[id]/actions.ts`(`submitCorrectionsAction`);Test `tests/integration/adjustments.test.ts`、`tests/unit/adjust-actions.test.ts`。

- [ ] **Step 1: 写测试**:
  - 合法更正端到端:草稿的 origin 为 correct;被编辑节 `edited:true`;其余节符合 §2.3。
  - 对抗文本在入队时被拒(`CORRECTION_REJECTED`,只返回规则代码),不入队。
  - 编辑 question 块被拒。
  - 更正共享调整限流。
  - 日志中没有编辑文字:捕获 `console` 输出并断言不含提交的文字。
- [ ] **Step 2–3:** 实现;`pnpm test`、`pnpm test:integration`(需要 Docker)。
- [ ] **Step 4: 提交** `git commit -m "feat: minimal text corrections as draft revisions"`。

---

### S4 — LLM 调整额度与 reduce_theory(分支 `feat/m6-llm-budget`,默认关闭)

### Task 20: bucket 种类与预留守卫

**Files:** Create `prisma/migrations/<ts>_bucket_kind_adjustment/migration.sql`(只含 ADD VALUE)、`prisma/migrations/<ts+1>_adjustment_buckets/migration.sql`(§2.1 S4 部分);Modify `prisma/schema.prisma`;Test `tests/integration/schema.test.ts`。

- [ ] **Step 1: 写测试**:
  - generate 作业的预留指向 adjustment bucket → 拒绝。
  - adjust 作业的预留指向 trial、paid 或其它课包的 adjustment bucket → 拒绝。
  - 同一课包的第二个 adjustment bucket → 23505。
  - adjustment bucket 带 subscription_id → 23514。
  - 漂移视图仍为空。
- [ ] **Step 2–3:** 迁移;`pnpm test:integration`(需要 Docker)。
- [ ] **Step 4: 提交** `git commit -m "db: per-lesson adjustment budget buckets"`。

### Task 21: LLM 入队、结算与释放

**Files:** Modify `src/lib/server/env.ts`(`ADJUSTMENT_LLM_ACTIONS`、`ADJUSTMENT_LLM_BUDGET_PER_LESSON`)、`src/lib/server/dal/instance.ts`、`src/lib/server/dal/adjustments.ts`、`src/lib/server/dal/settlement.ts`、`src/lib/server/dal/history.ts`(不改;测试断言其输出不受影响);Test `tests/integration/adjustments.test.ts`。

- [ ] **Step 1: 写测试**:
  - 预算 B 时,第 B+1 个 LLM 调整 → `AdjustmentBudgetExhausted`。
  - 两个请求竞争最后一单位:恰好一个成功。
  - 成功一次消耗一次;失败、取消、超时、扫描器都只释放一次。
  - 自动重试复用原预留。
  - 旧 worker 晚到提交:不消耗。
  - 同键重放:只预留一次。
  - 丢弃草稿后 used 不变。
  - trial bucket 与 `getAllowance` 的输出全程不变。
  - 配置值变化不影响已有 bucket 的上限。
- [ ] **Step 2–3:** 实现;`pnpm test:integration`(需要 Docker)。
- [ ] **Step 4: 提交** `git commit -m "billing: per-lesson LLM adjustment budget with single settlement"`。

### Task 22: reduce_theory 执行器(S6,前置条件:M3b 已配置并完成受控评估)

**Files:** Create `src/lib/package/prose-shorten.ts`(提示版本 `shorten/1`、响应 schema、`checkText`);Modify `worker/adjust.ts`;Test `tests/unit/prose-shorten.test.ts`、`tests/integration/adjustments.test.ts`。

- [ ] **Step 1: 写测试**(假 LLM):
  - 合格输出 → explanation 与 derivation 为 regenerate(method llm),worked_examples 只 rehash。
  - 注入式输出(含 `META_TEXT`、数字、课程词)修复一次后仍不合格 → 作业失败并释放额度。
  - 输入中的导师编辑文字以 JSON 数据字段传递。
  - 超过预算 → `budget_exceeded`。
  - 生产环境下使用假提供方时作业失败。
- [ ] **Step 2–3:** 实现;启用前先运行一次受控真实评估并记录到 `docs/decisions.md`(同 D-42)。
- [ ] **Step 4: 提交** `git commit -m "feat: model-assisted reduce-theory adjustment (disabled by default)"`。

---

## 3. U6 需要的后端清单(只列接口,不实现 UI)

- **读取**:
  - `webDal().adjustments.getAdjustmentState(ctx, lessonId)`:动作可用性与原因、草稿摘要、活跃作业、LLM 剩余额度、可编辑字段地图。
  - `webDal().lessons.getLessonView(ctx, lessonId, rev)`:`status` 区分 current、earlier、draft。
  - `getLessonPackage`:HTML 预览,含草稿。
  - `getArtifact`:草稿 PDF。
- **写入**(Server Actions):`requestAdjustmentAction`、`submitCorrectionsAction`、`acceptDraftAction`、`discardDraftAction`;取消用 `cancelJobAction`。
- **轮询**:`GET /api/jobs/{id}`(新增 `kind` 字段);成功后作业页跳转 `/lessons/{id}?rev={draftId}`。
- **U6 的 E2E 新增**:见 §2.9 末行;保留既有 `data-testid`。建议新增 `draft-banner`、`accept-draft`、`discard-draft`、`adjustment-panel`、`correction-drawer`。

---

## 4. 需要产品负责人决定的事项

| # | 问题 | 推荐 | 如果选错的代价 |
|---|---|---|---|
| 1 | 每课包 LLM 调整额度默认值(配置键 `ADJUSTMENT_LLM_BUDGET_PER_LESSON`) | **5**(`TEST VALUE`);bucket 首次使用时固定上限 | 太低:导师不敢用;太高:成本上升(按 D-42 的配置单价,每次约 1 美分量级,未核实)。可改配置,但已建 bucket 不追溯 |
| 2 | v1 动作集 | 更容易、更难、增加练习、增加例题、更改课时 + 文字更正;推迟展开步骤、减少理论(LLM)、聚焦目标 | 推迟项需要另外的生成器、校验器或 schema 工作;若硬塞进 v1,数学可验证性有风险 |
| 3 | 调整与 3 次免费生成的关系 | **永不消耗**(CLAUDE.md 已规定),由 DB 触发器强制 | — |
| 4 | 丢弃草稿是否退还 LLM 额度 | **不退** | 若退,同一额度可无限重刷模型调用,形成成本漏洞 |
| 5 | 速率与配额数字 | 每用户 30/时、150/日;每 IP 60/时;每课包同时 1 个;每用户同时 2 个(`TEST VALUE`) | 太紧影响体验;太松让编译主机(4 GB / 2 vCPU,D-20)排队 |
| 6 | "更改课时"是否进 v1 | 进,放在 S1/S3 的最后,可单独砍掉 | 它改提纲、计时与题数,测试面最大 |
| 7 | 接受/丢弃语义 | 可以在草稿上连续叠加;一次接受;接受前允许预览与下载草稿 PDF(文件名标 draft);有作业进行中时禁止接受或丢弃 | 若不允许叠加,多步调整要逐个接受,体验差;若允许下载草稿,导师可能误用未接受的版本(用标注缓解) |
| 8 | 增加练习是否保持课时不变 | 保持(计时不变,界面提示) | 若自动加时,会连带重写 teaching_sequence |
| 9 | 订阅过期后能否调整 | 确定性调整与更正**可以**(CLAUDE.md §5:过期后仍可编辑、重新编译);LLM 调整用已发放的课包额度,**可以** | 若禁止,与"历史成果仍可编辑"相矛盾 |
| 10 | 更正禁止数字的可用性 | 保持禁止(与生成文字规则一致) | 放宽要重新评估数字与答案不一致的风险 |
| 11 | 版本号显示 | 显示"第 N 个已接受版本"(按已接受修订排序计算),内部 `number` 允许跳号 | 若直接显示 `number`,丢弃的草稿会造成跳号 |
| 12 | 丢弃草稿的对象保留期 | 保留到课包删除;P3 对账再定保留期 | 存储增长(小) |

---

## Open questions for the owner

1. **默认 LLM 调整额度**:是否接受每课包 5 次(`TEST VALUE`)?额度应在课包首次使用时固定,还是随配置实时变化?
2. **v1 动作集**:是否同意 v1 只做确定性动作(更容易、更难、增加练习、增加例题、更改课时)加文字更正,把"展开分步解答""减少理论""聚焦目标"推迟?(前两者需要新的可验证步骤类型或 LLM;"聚焦目标"目前没有确定性含义。)
3. **"更改课时"是否进 v1**?它是改动面最大的确定性动作。
4. **草稿语义**:是否允许在草稿上连续叠加调整,然后一次接受?接受前是否允许下载草稿 PDF(文件名标 draft)?
5. **丢弃退款**:确认丢弃草稿不退还已消耗的 LLM 调整额度。
6. **速率数字**:是否接受 30/时、150/日(用户)、60/时(IP)、每课包同时 1 个作为开发默认?
7. **增加练习**:是否保持课时与计时不变?
8. **订阅过期后**:是否允许确定性调整与使用剩余课包额度的 LLM 调整?
9. **更正中的数字禁令**:是否接受导师无法输入任何数字(包括 "step two" 这类)的限制?
10. **版本号**:界面显示"已接受版本序号"而不是内部修订号,是否可以?

**我无法验证、需要在实施时确认的假设**:
- 固定的 Prisma 7.x 迁移是否在事务中执行(影响 `ADD VALUE` 必须单独成一个迁移文件)。
- 每份文档的真实编译耗时(没有系统测量,D-20)。
- LLM 价格只是用户配置值,未与官方价目核对(D-40/D-42)。
- 其它测试是否把 current 指向非 finalized 修订(Task 11 Step 1 会 grep)。
- 所有集成、LaTeX、Supabase 与 E2E 测试在本机(WSL 无 Docker)都无法运行。

### Critical Files for Implementation
- /home/yangzi33/noteprep/src/lib/package/validate.ts
- /home/yangzi33/noteprep/src/lib/package/build.ts
- /home/yangzi33/noteprep/prisma/migrations/20261019030000_constraints_roles_rls/migration.sql
- /home/yangzi33/noteprep/src/lib/server/dal/settlement.ts
- /home/yangzi33/noteprep/worker/pipeline.ts
- /home/yangzi33/noteprep/src/lib/server/dal/generation.ts
- /home/yangzi33/noteprep/src/lib/server/dal/lessons.ts
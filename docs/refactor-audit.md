# 重构审计(2026-10-19)

> 状态:审计与计划;**2026-10-19 已根据用户的决定(D-30/31/33,D-36 推迟)对账并更新既有文档与 `CLAUDE.md`**(§5 记录了对账内容)。事实来自对仓库的实际检查;无法核实的内容标为"待核实"。
> 相关:[product-vision](product-vision.md) · [curriculum-architecture](curriculum-architecture.md) · [refactor-plan](refactor-plan.md)

## 0. 先说结论

1. **已建成的是"基础设施",不是"生成产品"。** 认证、数据库与额度事务、worker、数学内核与题目生成器、选择→状态→历史的 UI 骨架都真实可用且有测试;但**没有真实 LLM 适配器、没有 LaTeX 渲染器与沙箱、没有 PDF 预览/导出、没有编辑器、没有 Stripe**。"现有生成流水线"目前跑的是假 LLM 和一个标注 `SKELETON - NOT A COMPILED PDF` 的假编译器。
2. 因此新愿景**几乎不与已写代码冲突**,冲突主要在**尚未实现的设计与文档**(两份"版本"文档、编辑器计划、`.tex` 导出、`lesson-content/1` 设计)。迁移成本低,风险集中在**新增**能力:课程数据的来源与授权、沙箱主机、调整的计费语义。
3. 现有**没有生产数据**:staging 只有测试账号;本地与 CI 数据库都是一次性的。"保留现有课包与用户数据"在今天是低风险,但本计划仍按"加法迁移 + 回滚脚本"设计,因为一旦上线就不再成立。
4. 最大的外部阻塞是**课程数据**:本次尝试从官方来源核实 Ontario 与 Common Core 的条目,**均未成功**(见 §6)。M1 之前必须由人提供/确认官方来源与授权。

## 1. 仓库事实

| 项 | 事实 |
|---|---|
| 技术栈 | Next.js 16.4 App Router、TypeScript strict、Tailwind、shadcn/ui;Prisma 7.10 + PostgreSQL;Supabase Auth;独立 worker(tsx);Vitest、Playwright;GitHub Actions |
| 路由 | `/`、`/login`、`/account`、`/lessons/new`(自由表单)、`/lessons`(历史+额度)、`/jobs/[id]`(状态,轮询)、`/auth/callback`、`/healthz`、`/api/jobs/[id]` |
| 数据库 | 10 张表(Profile、Lesson、LessonRevision、GenerationJob、IdempotencyKey、UsageBucket、UsageReservation、Subscription、WebhookEvent、RateLimitWindow);2 个迁移(`init_schema` + 手写的约束/触发器/角色/RLS);`app_runtime`/`worker_runtime` 无 BYPASSRLS |
| 代码量(约) | domain 265 行、math 830、server(DAL/auth/db)980、llm 80、latex 70(仅骨架)、storage 60、ui 110、components 180、app 420、worker 370;测试 ~3250 行 |
| 测试 | 单元 164、集成 94(真实 Postgres)、Supabase 边界 15(真实 Auth/Data API)、端到端 7(真实浏览器 + 真实 worker)= 280;全部在 CI 通过,另做过多轮变异检查 |
| 数学 | `src/lib/math`:精确有理数、一元一次方程求解/逐步验证/最终形式、`verified/failed/unverified` 状态规则、内容哈希、**参数生成器**(种子化、按难度);32+8 个人工审定 fixtures,独立 Python 交叉核对 |
| 部署 | staging 已上线:Vercel(`noteprep.app`)+ Supabase 托管项目;迁移通过手动、需审批的 GitHub 工作流;**没有 worker 主机** |
| 不存在 | 真实 LLM 适配器;课程数据(任何形式);LaTeX 渲染器/模板;沙箱与 runner;PDF 预览与下载;内容编辑器;Stripe/订阅;Supabase Storage 适配器(仅端口 + 本地磁盘实现);课包的内容 schema(`lesson-content/1` 只在设计文档里) |

## 2. 子系统分类

| 子系统 | 判定 | 理由 |
|---|---|---|
| 路由与应用外壳(导航、会话刷新 proxy) | **KEEP + MODIFY** | 外壳可直接沿用;新增 `/prepare`(选择向导)与 `/lessons/[id]`(课包页);`/lessons/new` 在 M2 验收后退役 |
| 认证(Supabase、`getClaims` 非对称白名单、邮箱确认后建账) | **KEEP** | 与产品方向无关,已有真实栈测试与伪造令牌测试 |
| 数据库/ORM(Prisma、角色、RLS、约束、触发器) | **KEEP**;新增表走**加法迁移** | 现有约束(一次性终态、不可变修订、预留单向)正是新愿景要依赖的不变量 |
| 额度与任务(桶/预留/幂等/围栏/租约/sweeper/结算) | **KEEP** | 新愿景不改变"完整生成=1 次、失败返还、一次结算";仅 `adjust` 作业类型的计费需**新决定**(见计划 D-33) |
| Worker 流水线控制流(领取、心跳、预算、重试、取消) | **KEEP**;`pipeline.ts` **MODIFY** | 控制流与结算是资产;阶段内容要换成"课程上下文→提纲→分节生成→验证→渲染" |
| 数学内核(有理数、求解、验证、报告) | **KEEP + EXTEND** | 是"数学可信"承诺的核心;需要按"概念(concept)"注册其能力,覆盖范围决定哪些课程主题可选 |
| 题目生成器(种子化、按难度) | **KEEP + EXTEND** | "确定性出题"正好支撑 M6 的大多数预设调整(更易/更难/加题)而无需 LLM |
| AI 模型集成(`LlmProvider` 接口 + 假实现) | **MODIFY** | 接口薄且供应商无关,可沿用;但**没有真实适配器,也没有可复用的"现有 AI 生成逻辑"**;需扩展任务类型(提纲文字、讲解、叙述)并写第一个真实适配器(M3b) |
| LaTeX 渲染基础设施 | **不存在 → 新建(M4)**;骨架(`SkeletonCompiler`、`skeleton.ts`)**REMOVE** | 只有标注为非 PDF 的占位;沙箱 spike 需要一台 Linux 主机(未就绪) |
| PDF 预览/导出 | **不存在 → 新建(M5)** | 现在没有任何下载功能 |
| 文档编辑器 | **不存在**;旧计划里的 P2-T8 编辑器 **DEPRECATE(取消)** | 代码里没有可复用或需删除的编辑器;只需把计划从"编辑器"改为"预览+调整+极小更正" |
| 内容 schema(`lesson-content/1`) | **MODIFY(设计层)** | 只存在于文档;没有已存数据依赖它。新的 `lesson-package/1` 需要分节、稳定 ID、依赖边与逐节哈希(见计划 §3) |
| 用户输入模型(`GenerateInput` v1、`/lessons/new` 表单、请求哈希) | **MODIFY** | 自由文本 → 课程引用 + 选择项;v1 在迁移期保持可读(已有任务的 `request_hash` 带版本号) |
| 产物清单(4 文件:学生/教师 × tex/pdf;`assertManifestComplete`、路径里的 `edition`) | **MODIFY** | 变为 3 份文档(notes/worksheet/solutions)的版本化清单;旧清单对旧修订继续有效 |
| 存储(端口 + 本地磁盘;路径与归属设计) | **KEEP(设计)+ MODIFY(路径段)** | 私有桶、服务端生成路径、短时签名 URL 的设计不变;`edition` 路径段改为 `document` |
| 订阅与支付(Stripe) | **UNKNOWN / 未实现** | Phase 3 才做;设计(webhook、权益表)不受影响;只需为"调整"定义计费 |
| 测试 | **KEEP + EXTEND** | 新增:课程映射/级联选择、课程上下文到达生成引擎、结构化输出、渲染/导出、"调整不静默改动无关内容" |
| CI/CD(4 个作业 + 迁移工作流) | **KEEP + MODIFY** | 新增数据集校验作业(引用完整性、来源完整性);M4 起增加沙箱作业 |
| Staging 环境 | **KEEP** | 正在使用;迁移走既有的审批工作流 |
| 文档 | **MODIFY(经对账后)** | 见 §5 |

## 3. 最大的架构错位(按影响排序)

1. **课程是缺席的一等概念。** 现在连数据结构都没有;输入是自由文本 + 单一硬编码主题枚举(`SUPPORTED_TOPICS`)。需要课程域模型、有来源的数据集、以及"课程主题 ↔ 引擎能力"的映射。
2. **文档集合不同。** 旧产品是"两个版本"(学生版/教师版,各 tex+pdf=4 文件);新愿景是**三份文档**。清单、校验函数、路径约定、渲染入口都以两版本为前提(例如 `EDITIONS = ["student","teacher"]`)。
3. **内容模型无法支持"只重新生成受影响部分"。** 设计里的课包内容是整体 JSON;没有分节边界、依赖边、逐节输入哈希,也没有"确定性生成"与"LLM 生成"的区分标记。
4. **编辑器优先的计划与新体验相反。** 好消息是还没写;坏消息是它在计划与文档里占了位置(P2-T8、product.md §3、architecture §7.6)。
5. **`.tex` 对用户可见。** CLAUDE.md 要求导出 `.tex` 并允许用户外部编辑;新愿景要求 LaTeX 完全在幕后。这是产品决定,不是技术问题。
6. **部分 AI 重写的计费语义未定义。** CLAUDE.md 明确推迟到语义清楚为止;新愿景把它放进核心功能,所以必须先决定(§5.3)。
7. **验证覆盖窄于课程主题。** 数学内核目前只覆盖 `ax+b=c`、`ax+b=cx+d`(含分数系数、无解/恒等式);不含括号/分配律、分式方程、不等式。课程数据集里的许多主题我们**无法验证**,必须在数据里显式标记,而不是让界面给出可选但不可靠的主题。

## 4. 可复用的资产与技术债

**可复用(价值最高在前)**:额度/任务事务与不变量(已被变异测试保护);数学内核 + 生成器 + fixtures;worker 控制流;真实栈测试方法(Postgres、Supabase、Playwright);CI;staging 与迁移工作流;认证与所有权矩阵测试。

**技术债与已知缺口**:
- `GenerateInput`、`SUPPORTED_TOPICS` 与表单字段绑定在一起,要拆成"课程引用"与"生成参数"。
- 作业只有 `generate` / `compile` 两种类型;"调整"需要新类型,而触发器 `generation_job_reservation_shape` 规定 generate 必须有预留、compile 不得有——`adjust` 取决于计费决定。
- `lesson_revision.artifact_manifest` 是无版本的 JSON;需要 `manifestVersion` 才能让新旧清单共存。
- 孤儿对象清理、IP 限流接入、成本上限与熔断(P3)仍未做,与本次重构独立。
- 本地 Docker 内的 gVisor 与真实沙箱主机都未验证(P2-T6),是 M4 的最大不确定性。
- 课程数据的**授权**未评估(见 §6)。

## 5. 与既有文档和 CLAUDE.md 的冲突

### 5.1 既有文档(**已于 2026-10-19 对账**;下表是当时识别的冲突,处理方式:在文首加方向调整提示,并修订或标注【已被取代】)

| 文档 | 与新愿景冲突/需更新的部分 |
|---|---|
| product.md | §2.1 输入(自由文本字段)、§3 流程("编辑内容")、§4 输出(两版本、`.tex`)、§6 验收场景 AS-05/AS-06(编辑与"未验证确认")需改写;§4.2 额度规则本身**不变** |
| architecture.md | §7.1 事实来源表(两版本)、§7.2 示例 JSON(`lesson-content/1`,将被 `lesson-package/1` 取代)、§7.6 编辑/失效/导出(编辑器)、§10 存储路径中的 `edition`、§11 编译产出(两版本);§4–§6、§8、§9 基本不变(§8 的 LLM `task` 枚举要扩) |
| implementation-plan.md | Phase 2 的 P2-T3(内容 schema)、P2-T4(渲染)、P2-T7(真实流水线)、P2-T8(编辑器)、P2-T9(下载)、P2-T10(E2E)被 [refactor-plan](refactor-plan.md) 的里程碑取代或改写;P2-T1/T2 已完成;P2-T5/T6 保留;Phase 3/4 基本不变(增补"调整"的计费) |
| test-plan.md | §2 数学 fixtures 保留;新增课程数据集、上下文传递、调整不改动无关节、渲染/导出 |
| security-and-privacy.md | 新增:课程数据授权、上传(之后)的版权/隐私/保留;§4 的 LaTeX 威胁不变 |
| decisions.md | 新增 D-30 起的决定(见 refactor-plan) |

### 5.2 CLAUDE.md:发现的冲突与修改(**已应用于 2026-10-19**;下表为修改依据。计费语义按 D-33 定稿,`.tex` 按 D-31 不提供)

| 位置 | 现有文字 | 冲突 | 拟议修改 |
|---|---|---|---|
| §1 产品范围 | "accept a topic, learner level, learning objectives, … generate editable lesson handouts, exercises, answers…; export LaTeX source and genuinely compiled PDFs" | 输入变为选择;不再强调可编辑、不再面向老师导出 LaTeX | 改为:"从受支持的课程数据集中选择课程体系/级别/课程/主题,配置时长与难度,生成 Notes/Worksheet/Solutions;导出真实编译的 PDF;结构化内容为规范数据源,`.tex` 仅作内部派生物(是否对外提供见决定 D-31)" |
| §1 | "Default to printable handouts… Provide a student edition and a teacher answer edition… A complete lesson pack includes both editions in .tex and PDF formats." | 文档集合不同 | "完整课包 = Notes、Worksheet、Solutions 三份 PDF(及其内部 `.tex`);Worksheet 不得包含独立练习的答案" |
| §1 | "User flow: sign in → enter requirements → track generation → edit content → revalidate and preview → download…" | 流程变化 | "sign in → 选择 → 生成(可跟踪)→ 预览 → 预设调整/极小更正 → 导出 → 历史与额度 → 订阅" |
| §1 | "Make educational level, language, curriculum explicit settings; do not claim alignment … without evidence." | 方向一致,现在有了证据机制 | 补充:"课程对齐声明只能由所选、受支持的课程数据集渲染(含版本与来源),LLM 输出不得包含对齐声明" |
| §5 | "AI regeneration of an entire pack is a new generation. Defer partial AI rewriting until its billing semantics are explicit." | 部分重写成为核心功能 | 在决定 D-33 定稿后改为明确的"调整"计费规则;在此之前保持原文 |
| §7 | "Provide a limited, understandable content editor. Exported .tex can be freely edited externally. The initial release must not accept arbitrary user .tex files…" | 编辑器被"预览+调整+极小更正"取代;`.tex` 不再面向用户 | "提供预览与预设调整;允许对**文字字段**做极小的手动更正(不改数学);`.tex` 不对外提供(或按 D-31);不接受任意用户 `.tex`(不变)" |
| §7 管线 | "validate input → establish supported scope/budget → generate structured LessonDraft → …" | 缺少课程上下文与提纲规划 | 在前面增加"解析课程上下文 → 规划提纲",并要求分节生成与按节哈希 |
| §7 | "Known mathematical errors block final export. Unverified manual edits may be exported only after explicit tutor acknowledgment" | 手动编辑范围缩小为文字 | 保留阻断规则;确认机制只在存在未验证的**数学**内容时适用 |
| §3/§4 | "Suggested modules: …src/lib/math, src/lib/latex …" | 需要新增模块 | 增加 `src/lib/curriculum`、`data/curricula/`(数据集)、`src/lib/package`(课包内容与分节/依赖) |
| §11 | 测试清单 | 缺少新类别 | 增加:课程映射与级联选择、上下文到达生成引擎、调整不改无关节、渲染/导出 |

**不需要改动的 CLAUDE.md 规则**:额度不变量、幂等、围栏、Stripe/权益、认证与所有权、私有存储、沙箱隔离、秘密管理、工作方式与 Git 流程。

## 6. 课程数据来源:本次核实的结果(重要)

本次尝试从官方来源核对候选课程,结果如下,所以**我不能在没有你提供/确认来源的情况下写入任何课程条目**:

- **Ontario(中学数学,2021 年起的 9 年级去分流课程 MTH1W)**:课程与代码(如 MTH1W)在多所学校的课程大纲中出现,但**官方站点(dcp.edu.gov.on.ca)是 JavaScript 应用,我的抓取工具读不到正文**;搜索只返回学校/第三方文档(二手资料,编号与措辞可能不同)。条目(如"C2.x")的原文**未核实**。
- **Common Core(美国)**:`corestandards.org` 的路径返回 404;能访问的 `thecorestandards.org` 页面自称是**非官方**资源;搜索结果显示其"Commercial License"页面把版权与许可使用写得很明确(该授权的适用范围**待法务确认**)。8.EE.C.7 的措辞在多个第三方页面一致,但**不能**作为引用来源。
- **授权风险(两者共通)**:课程文本是受版权保护的政府/组织出版物。商业产品大段复制原文可能需要授权或许可。设计上采用"**存标识符 + 自己写的简短释义 + 指向官方来源的引用**",不存原文(见 [curriculum-architecture](curriculum-architecture.md) §5)。是否需要正式授权属于**法律问题,待你或法务确认**,我不作结论。

建议:M0 由你**提供**所选课程的官方 PDF/页面(或确认来源与授权),我据此逐条转写**释义 + 页码引用**,再由你或学科专家抽检签字,之后才入库。

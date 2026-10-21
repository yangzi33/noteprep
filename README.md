# noteprep

noteprep.app

面向独立私人 STEM(首个学科:中学数学)辅导老师的备课自动化:**选择**课程体系/级别/课程/主题与时长、难度,几分钟内得到一套排版专业的课包(Tutor Lesson Notes、Student Practice Worksheet、Solutions/Answer Key);预览、用预设快速调整,再导出 PDF。LaTeX 完全在幕后,老师不需要写或编辑 LaTeX。方向详见 [docs/product-vision.md](docs/product-vision.md)。

## 当前状态:Phase 1 已完成并合并;Phase 2 进行中(重构里程碑 M1–M5 已完成并合并,下一步 M6;下方"Phase 1 当时的状态"为历史记录)

- 已有:固定的工具链、Next.js App Router 骨架(TypeScript strict、Tailwind、shadcn/ui)、`/healthz`、Vitest、架构边界的 ESLint 规则、Prisma schema 与迁移(含 CHECK/部分唯一索引/触发器/运行时角色/RLS,见 [docs/database-roles.md](docs/database-roles.md))、真实 Postgres 上的集成测试。
- 额度与任务的 DAL 事务(`src/lib/server/dal`):账户初始化、创建生成(幂等 + 限流 + 预留 + 入队,一个事务)、取消、围栏式提交成功/失败结算;在真实 Postgres 上有并发与故障用例,并做过变异验证。
- 认证:`@supabase/ssr` + `proxy.ts` 仅刷新会话;`requireUser`/`requireAccount` 用 `getClaims` 验签(只接受非对称算法),邮箱经 `getUser()` 确认后才创建账户与试用额度;登录/注册/登出与 `/account` 页面;在真实本地 Supabase 上测试了伪造令牌、未确认邮箱、Data API 无法访问业务表。
- Worker 骨架(`worker/`,`pnpm worker:dev`):`SKIP LOCKED` 领取、租约+心跳、围栏 token、单一总预算、有界重试(指数退避+抖动)、取消、sweeper(过期租约/截止时间/重试用尽;释放预留;报告计数漂移)、优雅退出。流水线使用假 LLM、**仅骨架用的假编译器**(产物以 `SKELETON - NOT A COMPILED PDF` 开头,生产环境拒绝启动)和本地磁盘对象存储;数学验证与排版是 Phase 2 的占位。
- UI 骨架:导航、创建课包表单(幂等键随表单实例生成)、任务状态页(服务端渲染 + 轮询,刷新不丢)、取消、历史与剩余额度;所有页面与 `/api/jobs/[id]` 仅对所有者可见。(Phase 1 当时课包文件是占位物;M5 起有真实 PDF 的预览与下载,见下方 M5 一节。)
- Playwright 端到端(真实浏览器 + 本地 Supabase + 真实 worker 进程):登录→生成→完成→历史;重复提交与刷新不重复消耗;取消返还额度;超时失败给出清晰提示并返还额度;三次后第四次被拒(页面与服务端);跨用户隔离;未登录重定向。
- **Phase 1 当时尚无**(其后已补:真实 LLM 适配器 M3b、数学验证与课包验证 M3a、LaTeX 编译与沙箱 M4、PDF 预览/下载 M5):Stripe;至今仍无:定期孤儿对象对账(P3)、IP 级限流接入(DAL 支持 `ipHash`,Web 尚未传入,P3-T2)。**仍不是可上线产品**(见各里程碑的"未验证")。
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
# WSL2 + Windows 浏览器:`pnpm dev` 绑定 127.0.0.1(IPv4 回环)。默认的 IPv6 通配监听在 Windows 上打不开 http://127.0.0.1:3000(而 localhost 能打开),已用 PowerShell 实测;不要改成 0.0.0.0(会暴露到局域网)。
pnpm supabase:stop
```


数据库注意事项:

- 本机 5432 端口可能被其他项目占用,所以本项目使用 54329。
- 非交互环境中请用 `db:migrate:deploy`;`db:migrate:dev` 需要交互式终端(生成新迁移时使用)。
- **不要重新运行 `prisma init`**:它会把第三方 "agent skills" 文本从 GitHub 下载到 `.agents/`、`.claude/`、`.windsurf/` 并写入 `skills-lock.json`。这些内容未经审阅,已删除且不应提交。
- `pnpm install` 会触发根包的 `postinstall`(`prisma generate`,不需要数据库连接),生成物位于被忽略的 `src/generated/prisma`。

尚未建立(见实施计划):`test:latex`(Phase 2)。`test:supabase` 与 `db:up`/`db:down` 等是额外加入的命令。

## CI

`.github/workflows/ci.yml`(pull request 与 push 到 `main`;PR 不使用仓库秘密):静态检查与构建、真实 Postgres 集成测试、本地 Supabase 栈的认证/Data API 边界测试。`.github/workflows/images.yml` 手动发布 worker/LaTeX/hosttest 镜像(见"Worker 打包与 staging 主机")。`.github/workflows/db-migrate.yml` 仅手动触发、仅 `main`、需要 `staging`/`production` 环境审批,用于对托管数据库执行 `prisma migrate deploy`。第三方 action 固定到提交 SHA;pnpm 通过 corepack 按 `packageManager` 精确版本安装。**`ci.yml` 已在 GitHub 上实际运行:PR #1 的三个作业全部通过(2026-10-19);`db-migrate.yml` 尚未运行过(需要你创建的环境与秘密)。** 端到端(Playwright)作业随 P1-T7 加入。Staging 准备清单见 [docs/staging-setup.md](docs/staging-setup.md)。

## 产品方向调整(2026-10-19)

产品改为**选择优先、课程感知、预览 + 调整**,取代原先的"输入需求 → 编辑器"。已批准的决定:MVP 目标课程是 **Ontario Grade 9 数学**,但**真实课程数据集是之后的独立里程碑**(CM,届时一并决定课程文本授权);**不向用户提供 `.tex`**(只导出 PDF);调整计费采用"确定性调整免费、含模型的调整消耗每课包调整额度"。文档与 `CLAUDE.md` 已按此对账。**里程碑 M1(课程域模型 + 示例数据集)、M2(选择向导 + 请求 v2)、M3a(课包内容模型 + 确定性生成)、M3b(LLM 适配器与文字检查)、M4(三份文档的渲染与沙箱编译)与 M5(PDF 预览与导出)已完成**(见下);预设调整与文字更正是 M6,尚未开始。详见 [docs/refactor-plan.md](docs/refactor-plan.md)。**已建成的是基础设施**(认证、额度/任务、worker、数学内核与题目生成器、选择→状态→历史的 UI 骨架、课程域);PDF 预览与下载界面已有(M5);**尚无**真实课程数据(CM 里程碑)与调整(M6)。

## M1 课程域(完成)

- **数据库**:12 张公共只读表(教育体系、课程体系、版本、级别、课程、单元、主题、学习目标、主题↔目标、先备知识、概念、主题↔概念),两个迁移(Prisma 生成的表 + 手写的约束/触发器/授权)。**已发布版本不可变**(触发器:不能增删改任何子行,版本行只能 published→superseded→withdrawn 向前);复合外键把整棵树锁在同一个版本内;`real` 数据集必须带来源 URL、检索日期和人工核对记录;文本有长度上限;运行时角色**只读**,Data API 角色无权限(真实 Supabase 栈测试覆盖)。
- **数据集管线**:`data/curricula/<课程>/<版本>/` 四个 JSON 文件 → `pnpm curriculum:validate`(CI 每次运行)→ `pnpm curriculum:load <目录> [--allow-sample]`(用迁移所有者连接,幂等、原子、只新增版本;同版本内容不同则拒绝)。
- **读取层** `createCurriculumDal`:可见性(只有已发布版本;示例数据仅在 `CURRICULUM_ALLOW_SAMPLE=1` 的开发/staging 可见,合成数据仅测试可见,**生产默认什么都看不到**)、级联选择选项(无级别的体系自动跳过级别步骤)、`resolveCurriculumContext`(不可变快照 + `contextHash`,拒绝不受支持的主题)。主题是否"受支持"只由**代码里的能力注册表**决定,数据库里多出来的概念不会让任何主题变成"受支持"。
- **示例数据集**:`data/curricula/sample-math/sample-1`——**完全虚构,处处标注"不是真实课程"**;用它生成的课包不允许任何对齐声明(`alignmentClaimsAllowed=false`)。真实 Ontario 数据集是之后的 CM 里程碑。
- 测试:单元 +36(数据集 schema/每条规则/能力注册表),集成 +38(加载、不可变性、约束、可见性、级联、上下文);7 项变异检查均被发现。

## M2 选择向导与请求 v2(完成)

- **`/prepare`**:服务端渲染、**URL 驱动**的向导——课程体系 → [级别] → 课程 → 单元 → 主题 → 时长/难度/输出文档 → 生成。刷新、后退、分享链接都不丢状态;改动前面的步骤会清掉后面的选择。**不受支持的主题灰显并说明原因**,手工改 URL 也无法选中(页面与服务端动作各拒绝一次)。示例数据在页面上始终带"示例数据,不是真实课程"标注。
- **请求 v2**(`LessonRequestV2`):只有 ID 与有界选项,**没有任何自由文本字段**;课程上下文由服务端从 ID 解析,**浏览器不提供**。v1 与 v2 并存(旧的 `/lessons/new` 继续可用);请求是否为 v2 只看 `requestVersion`,格式错误的 v2 不会被当作 v1 放行。
- **同一个事务**:v2 请求在同一事务里先做幂等重放检查,再解析课程上下文,再限流、预留额度、建 lesson/job/reservation。被拒绝的主题**不占额度、不消耗幂等键**;已接受请求的重试即使课程版本之后不再提供也返回原任务。
- **迁移**(`20261019092400_lesson_curriculum_columns`):`lesson` 新增 `request_version`、`curriculum_version_id`、`topic_id`、`objective_ids`;CHECK 要求"v2 必须有完整的课程钉住、v1 不得有";复合外键保证主题属于该版本;触发器使钉住和输入快照**创建后不可变**。
- **worker**:同一条流水线通过 `normalizeJobInput` 处理 v1/v2;v2 的修订内容里保留完整、带哈希的课程上下文快照。
- 测试:单元 +9,集成 +11(含新迁移的守卫),E2E +5(逐步选择并生成、不受支持主题、不一致选择、刷新/后退、未登录);6 项变异检查中 4 项被发现,2 项经分析为等价变异(整个流程在一个事务里,先后顺序对外不可见);另外发现并补强了 2 个薄弱测试。

## M3a 课包内容模型与确定性生成(完成)

- **`lesson-package/1`**(`src/lib/package/`):分节的结构化内容——目标、先备知识、讲解、推导、例题、教学顺序、常见错误、练习、解答、课程信息共 10 节;每节有稳定 ID、`contentHash`(本节内容)与 `inputsHash`(本节参数 + 上游节内容);依赖边 `exercises → solutions`(derives)、`explanation → worked_examples` 等,`dependentsOf` 给出传递闭包。严格的 Zod schema。
- **类型层面防泄题**:每种节只允许它需要的块。练习节里**没有任何能携带答案的块类型**,`WorksheetView` 只由 `exercises`+`alignment` 构成,把解答节放进学生练习卷**无法通过编译**(测试里有 `@ts-expect-error` 断言)。
- **`buildPackage`**:同一请求、同一上下文、同一种子 ⇒ **逐字节相同**的课包。时间预算精确加总到所选课时;题目和答案、例题的分步解答**全部由已验证的生成器产出**(无模型);文字是模板化的、不含数字/公式/课程名。种子用 lesson id,所以重试同一任务不可能改变内容。非基础难度会加一道"无解"例题(能力注册表允许时)。
- **课程声明只来自数据集**:`alignment` 节由代码从课程上下文写入;示例/合成数据的声明永远是 `none`;只有 `real` 数据集才可能是 `aligned`。文字检查(`checkProse`)拒绝数字、公式符号、链接、`curriculum/aligned/standards` 等词和课程名/编码出现在生成文字里,并要求目标/先备知识文字与数据集**逐字一致**。
- **整课验证**(`validatePackage`):schema、结构与哈希重算、每道题的数学(沿用既有验证器)、文字规则。只有全部通过且每题 `verified` 才算 `verified`。
- **worker**:v2 作业不再调用模型(`calls_used = 0`),构建→验证→(仍是骨架渲染与编译)→存储→结算;验证不通过则作业失败、释放额度、不发布任何修订。修订的 `schema_version = 2`,内容是完整课包(含带哈希的课程上下文快照)。v1 作业保持原路径,既有额度/任务测试**未修改**即通过。
- 测试:单元 +31(含 7×3 种难度/时长组合全部 verified、确定性、哈希、依赖、视图、各类篡改被发现),集成 +3;10 项变异检查全部被发现。
- **已知限制**:`inputsHash` 目前只校验格式、不重算(M5 的调整会用到它);叙述是通用模板,不是针对主题的讲解(M3b 引入真实 LLM 后改进)。渲染与编译在 M4 完成,见下。

## M4 三份文档的渲染与沙箱编译(完成)

- **渲染器**(`src/lib/latex/`):`renderDocument`/`renderPackage` 把课包渲染成 Tutor Lesson Notes、Student Practice Worksheet、Solutions / Answer Key 三份 LaTeX。**一个固定模板在版本库里**(`classic/1`,Letter 纸,英文);文字经过转义(安全字符表,字体打不出来的字符变 `?`);数学**只由已验证的精确有理数和固定的操作词汇生成**(未知的数字/操作/解类型会报错,绝不原样放进文档);练习卷由类型上**不含解答**的 `WorksheetView` 渲染;每道练习与它的书写空间是一个不可分页的盒子。渲染是纯的、确定的,最后还有一道允许列表检查(正文里出现模板之外的控制序列、注释、`^^`、`#`、被改动的前言都会拒绝)——它补充沙箱,**从不替代沙箱**。
- **沙箱**(`docker/latex`、`src/lib/latex/sandbox.ts`):每次编译一个新容器——`--network none`、只读根文件系统、小的 `noexec` tmpfs、`--cap-drop ALL`、`no-new-privileges`、非 root、进程/内存/CPU/文件大小限制、**无宿主挂载、无 Docker socket、不继承 worker 的任何环境变量**、`--pull never`(编译时不下载任何东西)。输入用 stdin 传 tar,结果用 stdout 传 tar。宿主侧有墙钟超时和输出上限,超时/取消会杀掉并删除容器。镜像用摘要固定基础镜像,只在**构建时**安装 TeX/字体/poppler,TeX 包版本记录在 `docker/latex/packages.lock` 并由测试核对。
- **容器返回的一切都当作不可信数据**:严格的 tar 读取器(链接、`..`、长名、重名、超大、截断一律拒绝)、文件白名单、PDF 魔数与结尾、大小与页数上限、**活动内容扫描**(模板关闭了 PDF 对象压缩,使所有字典都是可读文本;含对象流的 PDF 直接拒绝,因为那意味着有人想把字典藏进压缩字节)。任何一份失败则整包失败,不会发布部分结果。
- **清单 v2**:`{manifestVersion:2, templateVersion, documents:[{document, pdf:{path,sha256,bytes,pages}, tex:{…}}]}`;结算在同一事务里核对"恰好是所请求的文档、每份都有 PDF 与源码、都在本次尝试的前缀下、哈希/大小/页数合法"。`.tex` 只是内部派生物,**不向用户提供**(D-31)。
- **worker**:`COMPILER=docker`(默认 `skeleton` 仅本地占位)、`LATEX_IMAGE`(生产必须用 `@sha256:` 摘要)、`LATEX_WALL_CLOCK_SECONDS`。真实编译器下,旧的 `/lessons/new` 作业会干净地失败并返还额度(它只会产出标注为占位的文件,绝不能存成真实结果)。
- **本地运行真实编译**:`pnpm latex:image`(构建镜像)→ 在 `.env` 里设 `COMPILER="docker"`(并可去掉 `ALLOW_FAKE_COMPILER`)→ `pnpm worker:dev`。`pnpm test:latex` 在**真实镜像**上运行 40 个测试(需要 Docker 和 `pnpm db:up`)。
- **测试**:单元 +98(渲染/转义/注入语料与模糊测试、tar 读取器、docker 参数、用假 docker 验证"容器返回什么才信"、清单 v2、worker 配置);`test:latex` 40 个(镜像钉版本、编译三份真实 PDF 且逐字节可复现、**OS 边界**:网络/文件系统/能力/seccomp/宿主可见性/环境变量/fork/内存/磁盘/输出/超时、**恶意 TeX**:shell escape、文件读写、路径穿越、展开炸弹、死循环、页数/日志炸弹、JavaScript/Launch 动作、隐藏对象流、**完整链路**:数据库→流水线→渲染→沙箱→存储→结算);集成 +8;CI 新增 `LaTeX sandbox` 任务(构建镜像并运行)。对沙箱做的变异检查(网络、只读根、能力、no-new-privileges、tmpfs 执行、进程数、root、宿主侧杀容器、活动内容扫描、结算清单、流水线各检查)全部被发现。
- **未验证/已知限制**:本地是 **runc + 默认 seccomp**,**没有 gVisor**,也没有在目标生产主机上验证(D-03/D-20 仍待定);没有 Stripe/LLM 参与的真实端到端;`CompileError.detail`(一行脱敏原因)目前只在编译器内部,尚未写入作业记录。

## M5 课包预览与导出(完成)

- **页面**:`/lessons/[id]?rev=…&doc=…`——三个标签页(Tutor Lesson Notes / Student Practice Worksheet / Solutions / Answer Key,只显示所请求的文档),预览是**真正编译出的 PDF**(浏览器自带查看器的 `<iframe>`),"在新标签页打开"与"下载 PDF"始终可用(预览不显示时的降级)。所有链接都带 `rev`,预览、下载、各标签页因此**永远来自同一个 revisionId**。页面还显示"AI 材料请先自己通读"的提示和**课程信息面板**:文字完全由数据集字段拼成;样例/合成数据集一律写"不是真实课程,不作对齐声明",即使存储的声明字段写着 aligned。`/jobs/[id]` 在作业成功后自动跳转到该页(旧的占位课包仍留在作业页)。
- **文件如何到浏览器**(`/lessons/[id]/documents/[doc]?rev=…[&download=1]`):验证会话 → DAL 按 `ownerId` 取该修订的**清单里**写着的 PDF 路径(路径从不来自请求)→ 用**用户自己的会话**向 Storage 签发 60 秒的签名 URL(因此 Storage 的 RLS 再检查一次;Web 不持有 secret key)→ 302,响应 `private, no-store`。别人的、已删除的、不存在的、旧占位课包的,一律同一个 404;未登录 401;`doc` 只能是 notes/worksheet/solutions,**没有任何办法请求 `.tex`**(D-31)。
- **Storage**(迁移 `…_storage_artifacts`):私有桶 `lesson-artifacts`(25 MB 上限);RLS 只有一条:`authenticated` 可 SELECT 路径首段等于自己 `auth.uid()` **且扩展名为 pdf** 的对象——浏览器没有任何写/改/删权限,`.tex` 连所有者本人也读不到。本地需要启用 Storage(`supabase/config.toml` 已改为 `enabled = true`;改后需要 `pnpm supabase:stop && pnpm supabase:start`,首次会拉取 storage 镜像)。迁移在没有 `storage` 模式的纯 Postgres(集成测试库)上会跳过这一步。
- **worker 写入**:`OBJECT_STORE=supabase` + `SUPABASE_URL` + `SUPABASE_SECRET_KEY`(只给 worker;生产强制 `supabase`)。默认仍是 `fs`(本地磁盘,测试用)——**用 `fs` 时预览页打不开文件**。
- **本地看到真实 PDF**:`pnpm latex:image`;`.env` 里设 `COMPILER="docker"`、`OBJECT_STORE="supabase"`、`SUPABASE_URL="http://127.0.0.1:54321"`、`SUPABASE_SECRET_KEY`(取自 `pnpm supabase:status`)→ 重启 `pnpm worker:dev` → 在 `/prepare` 生成 → 作业完成后自动打开预览页。
- **测试**:Supabase 边界 +11(适配器存取/删前缀/拒绝越界路径;私有桶公开 URL 无效;所有者能签发并下载与存入完全一致的字节;签名 URL 到期失效;所有者拿不到 `.tex`;他人/未登录拿不到;任何浏览器会话不能写/覆盖/删);集成 +6(越权矩阵:他人、已删除、未知 id、别的课包的修订、同一所有者另一课包的修订,清单来源,旧占位课包与草稿);单元 +6;E2E +2(真实 worker + 真实 Storage:三标签页、链接带 revision、每份文件的字节哈希等于清单、跨用户 404、未登录 401、`.tex`/越界参数 404;本地用 `E2E_COMPILER=docker` 在真实 PDF 上跑过)。对 Storage 策略(去掉扩展名条件/所有者条件/公开桶/开放写入)、DAL(所有者、已删除、修订归属、`.tex` 路径)、路由与页面(no-store、预览不带 revision、标签页丢 revision)做过变异检查,全部被发现;两处冗余防线(课包与修订各自的所有者过滤、`finalized` 状态与"清单只存在于已完成修订"的数据库约束)单独去掉不会失败——这是有意的纵深防御,同时去掉才会失败。
- **孤儿对象**:尝试在上传之后失败(存储错误、提交被拒、围栏 token 过期、上传后被取消)时,该尝试会尽力删除**自己的**前缀(删除失败只记录日志,不掩盖原错误;无法确认提交结果的数据库错误不删,以免删掉已发布的结果)。若 worker 在上传与清理之间崩溃,残留对象仍会留下;**定期孤儿对账尚未实现(计划在 P3)**,目前没有任何进程会扫描并删除它们。
- **Storage RLS 的边界**:策略只检查"路径首段等于自己的 `auth.uid()`"和 `.pdf` 扩展名;它**不知道**课包是否已删除或修订是否已发布。这些由应用的 Route Handler 强制(账号为 active、课包未删除、修订已完成且清单列出该文件);已记录为课包删除功能上线时要补上的已知限制(D-48)。私有 PDF 现在以 `Cache-Control: max-age=0`(每次重新验证)上传;此改动之前上传的文件仍是 `max-age=3600`;托管环境里签名路由实际返回的响应头尚未观察过(本地签名路由不带该头,已观察到的是对象自身的头)。
- **未验证/已知限制**:预览用浏览器自带 PDF 查看器——移动端兼容性没有在真机上测过(因此有降级链接);下载的"请求频率限制"尚未接入(CLAUDE.md 要求,P3);服务端不在每次发放前重新校验文件哈希(worker 写入时已校验);无版面视觉回归;调整与更正是 M6。

## 界面(Figma UI 落地,U1–U4;在栈式分支上,**其 E2E 与集成测试从未运行过**)

- **`/prepare` 的下拉级联需要 JavaScript**:课程体系/级别/课程/单元/主题的联动由客户端 `router.push` 驱动(URL 仍是状态,刷新/后退保留选择);关闭 JS 时联动不工作,没有 noscript 回退。**生成的 POST 本身不依赖 JS**(服务端动作)。这取代了上文 M2 描述的"链接式向导"。
- **HTML 草稿预览**(D-60):`/lessons/[id]?view=draft` 由**同一 revisionId 的结构化内容**在服务端渲染,带"Draft preview. The exported PDF is the final version."标注;默认视图仍是**真正编译出的 PDF**,PDF 才是权威的导出物,草稿不替代真实编译。草稿里的数学只来自已验证的有理数内容,经 KaTeX(`trust:false`、`strict:error`)渲染,无法表达时退化为纯文本。Worksheet 的草稿不含答案。
- **新依赖 `katex`**:`package.json` 里**固定为 `0.19.0`**(精确版本,无范围符)。它的 CSS 与字体由构建**打包到本地**(`src/app/lessons/[id]/page.tsx` 导入 `katex/dist/katex.min.css`),不从外部 CDN 加载。
- **验证清单**:这些页面改动在没有 Docker 的环境里写成,E2E/集成测试待在有 Docker 的机器上运行,命令顺序、未运行测试清单与 1440px/390px 的手动检查见 [docs/ui-verification-checklist.md](docs/ui-verification-checklist.md)。仪表盘(U5)与落地页(U7)在其他分支上进行中,尚未合并。

## Worker 打包与 staging 主机(设计与文件已完成;**未在任何真实主机上运行过**)

- **脚本**:`pnpm worker:build`(esbuild 打包到 `dist/worker/`)、`pnpm worker:start`(运行打包产物)、`pnpm worker:image`(构建 worker 镜像 `noteprep-worker:dev`,linux/amd64)、`pnpm worker:hosttest-image`(构建在主机上跑沙箱测试的 `noteprep-hosttest:dev`)、`pnpm smoke:staging`(对 staging 的冒烟,见下)。构建镜像需要 Docker。**本机(开发机)上做过**:`pnpm worker:image`、`test:image`(6–8 个测试通过)和 hosttest 容器(41 个测试通过)。**没有发生过**:`images.yml` 在 GitHub Actions 上的任何运行、任何真实主机、任何向 GHCR 的推送(`ci.yml` 的 `worker-image` 作业与 hosttest 步骤已在 PR #10 的 CI 里通过)。
- **镜像**:`docker/worker/Dockerfile`(运行时镜像不含秘密,uid 10001,基础镜像按摘要固定;`hosttest` 目标含 devDependencies 与 `tests/latex`)。发布:手动工作流 `.github/workflows/images.yml`(仅 main,先测试再推送,输出**摘要**到 Step Summary);主机只按摘要拉取。
- **主机**:[docs/worker-host-runbook.md](docs/worker-host-runbook.md) 是逐步的安装、验证与演练清单;主机文件在 [deploy/host/](deploy/host/)(systemd 单元、runner 的 rootless Docker drop-in、tmpfiles、`worker.env.example`、`worker.image.example`)。拓扑与取舍见 decisions D-52..D-56。
- **冒烟**:`read -rs SMOKE_PASSWORD; export SMOKE_PASSWORD`,然后 `SMOKE_TARGET=staging SMOKE_EMAIL=… pnpm smoke:staging`,结束后 `unset SMOKE_PASSWORD`(先 `pnpm exec playwright install chromium`)。目标只允许 `https://noteprep.app`;走真实登录表单;**每次运行消耗该一次性测试账户的 1 次免费生成**。
- **新的 worker 环境变量**:`DOCKER_HOST`(生产必须是 runner 的 unix socket,不能是宿主 rootful socket)、`WORKER_LIVENESS_FILE`(存活文件,供健康检查);二者在镜像里已设置,见 `.env.example`。
- **未验证**:以上全部在真实主机上的行为(rootless 守护进程与 socket 组映射、主机沙箱测试、重启/整机重启演练)、托管 Actions 上的 `images.yml` 发布工作流(PR #10 的 CI 已在 GitHub 上跑通 `worker-image` 作业与 `latex-sandbox` 里的 hosttest 步骤,但从未发布到 GHCR)、对真实 staging 的冒烟。**没有 gVisor(共享内核),runner 账户无出站防火墙,无镜像签名,无告警系统**;这不是生产就绪声明。

## 排查"作业为什么失败了"

作业失败时页面只显示一句话,原因在三个地方:
1. **数据库**(最权威):`generation_job.error_code`。本地查询:
   `docker exec supabase_db_noteprep psql -U postgres -c "select to_char(created_at,'HH24:MI:SS') t, state, error_code, attempt, max_attempts, calls_used from generation_job order by created_at desc limit 10;"`
   常见代码:`llm_invalid_output`(模型的回答无法使用)、`llm_auth`(密钥/权限问题)、`llm_rate_limited`/`llm_overloaded`/`llm_timeout`(可重试,用完次数才失败)、`budget_exceeded`、`validation_failed`(课包没通过验证)、`package_build_failed`、`deadline_exceeded`(没有 worker 在跑,任务超时)、`canceled`。
2. **worker 终端**(运行 `pnpm worker:dev` 的那个窗口):每行一个 JSON 事件,看 `job_claimed`、`job_requeued`、`job_failed`(带 `code`)、`job_succeeded`;日志**不含**课包内容、提示或密钥。
3. **修订的 `generation_meta`**(成功的作业):是否调用了模型、提供方/模型、尝试次数、是否回退到模板、被拒的规则代码(只有代码,没有文字)。

两个容易踩的坑:**没有 worker 在跑**,作业会一直"排队"直到超时失败;**旧的 `/lessons/new` 快速表单**不适用于真实模型(它的占位提示只能满足假提供方),所以真实提供方下它改为直接使用你输入的目标、不调用模型——想看真实模型写的文字请用 `/prepare`。**跑 `pnpm test:e2e` 前先停掉 `pnpm worker:dev`**:它们共用本地数据库,你的 worker 会抢走测试的作业(e2e 现在会在开始时检测并明确报错)。

## M3b LLM 适配器与文字检查(完成,已用真实服务做过一次小规模评估)

- **适配器**(`src/lib/llm/anthropic.ts`):按 Anthropic 官方 Messages API 文档(2026-10-19 核对)实现的 `LlmProvider`——固定端点、`x-api-key` 与 `anthropic-version` 头、`output_config.format` 的 JSON Schema 结构化输出(只用文档列出的受支持关键字)、`stop_reason` 与 `usage` 处理、HTTP 状态到错误类型的映射(429/5xx/529/超时可重试,其余不重试)。输入作为**一个 JSON 文档放在用户消息里,不拼进系统提示**;厂商错误正文**绝不**传出(只保留状态与 `request-id`);调用方取消会向上抛出而不是当作厂商错误。供应商默认是 Anthropic,**这是临时选择(D-40)**,接口不变,换供应商只需新增一个适配器。
- **配置**(只有 worker 持有):`LLM_PROVIDER=fake|anthropic`(默认 fake)、`LESSON_PROSE=template|llm`(默认 template,即 M3a 路径,也是**回滚开关**)、`LLM_API_KEY`、`LLM_MODEL`、`LLM_PRICE_INPUT_MICROS_PER_MTOK`、`LLM_PRICE_OUTPUT_MICROS_PER_MTOK`、`LLM_MAX_OUTPUT_TOKENS`。**价格与模型都没有默认值**——缺一项 worker 拒绝启动,仓库里不写任何价格。
- **模型写什么**:只写五段**纯文字**(讲解、推导、例题引言、教学顺序、常见错误);题目、答案、解答步骤、时间、课程声明仍全部来自代码与数据集。发给模型的只有:概念名与 ID、学习目标和先备主题的数据集措辞、方程类型与结果种类(用文字描述)、难度、课时——**不含**课程名称/版本/编码/哈希、账户信息、他人内容。
- **文字检查**(模板与模型输出共用,`prose-rules.ts`):拒绝数字、公式与标记符号、链接、课程声明/名称/编码、谈论指令或模型本身的文字("ignore previous instructions"、"system prompt"、"as an AI"、"JSON"…),并只允许字母、普通空格和常见标点(Markdown、方括号、反引号、emoji、换行、控制字符全部拒绝)。
- **有界修复 + 模板回退**:模型输出不合格 → 带着**规则代码(不是原文)**再请求**一次**;仍不合格 → 回退到 M3a 的模板文字,**课包照常完整、已验证、算一次生成**;元数据只记录尝试次数和被拒规则代码。供应商故障(鉴权/请求错误/过载/超时)走作业既有的重试与预算规则;费用超出作业预算 → 失败并释放额度。
- **手动评估**:`pnpm eval:prose --runs N --confirm-cost [--show] [--diagnose]`(**不进 CI**,会花钱;没有 `--confirm-cost` 拒绝运行;`--diagnose` 显示被拒绝答案的具体句子与规则)。**已对真实服务评估过一次**(Haiku 5.5,39 次运行,结果与发现见 [docs/decisions.md](docs/decisions.md) §8.1):首次通过约 92%、全部最终通过、每次约 7–10 千微单位(按用户配置的价格),评估发现并修复了长度上限与一条误报规则。启用 `LESSON_PROSE=llm` 前仍需人工(教师)抽查。
- 测试:单元 +81(适配器 38、文字规则/提示/编排/课包 43),集成 +7;9 项变异检查全部被发现。

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
| [docs/worker-host-runbook.md](docs/worker-host-runbook.md) | staging worker 主机的安装、验证、更新/回滚、告警查询与演练清单(**全部未在真实主机上验证**) |
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

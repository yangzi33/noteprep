# 决策记录

> 只记录对实现有约束力的内容。相关:[product](product.md) · [architecture](architecture.md) · [implementation-plan](implementation-plan.md) · [security-and-privacy](security-and-privacy.md)

## 1. 已确定的约束(来源:CLAUDE.md,不在此重新讨论)

终身合计 3 次免费完整生成;失败不扣次数;事务内预留/入队/幂等;预留单向迁移 `reserved → consumed|released`;围栏 token;Postgres 持久任务表(不引入 Redis/Kafka/K8s);独立 worker + 每任务隔离沙箱;Web 不运行 TeX;Prisma 直连需服务端 owner 过滤;Stripe 权益只经验签 webhook + 服务端对账授予;数学验证不得使用 eval/CAS/浮点;仅 Math、仅一元一次方程起步;Worksheet(原"学生版")不含独立练习答案;历史成果在订阅过期后仍可访问;不自动开通付费资源/部署。

## 2. 可逆默认选择(已作出,标为假设)

| ID | 选择 | 理由 | 反转条件 / 成本 |
|---|---|---|---|
| D-01 | 英文界面与课件,~~A4~~ **Letter**(2026-10-21 更正:D-46 已实现 Letter,见 D-70) | 需要一个具体默认;CLAUDE.md 要求不由对话语言推断市场 | 确定目标市场后改模板/文案;模板已版本化 |
| D-02 | pdfLaTeX + Latin Modern,自写小模板,无 `hyperref` | 最小攻击面、快、确定 | 需要非拉丁语言 → 评估 XeLaTeX/LuaLaTeX(见 D-05) |
| D-03 | 单台 VM + 容器运行时 + gVisor(runsc);runner 使用独立无秘密账户 | 满足禁网/无秘密/非 root/只读根/限额;运维面小;不需要 KVM | gVisor 兼容性/负面测试不过 → Firecracker 微虚拟机(见 architecture §11.2) |
| D-04 | 首个真实 LLM 适配器默认 Anthropic Claude,模型/超时/成本均为配置 | 需要一个首发适配器;接口与供应商无关 | 换供应商只改一个适配器文件;需重跑契约测试与质量评估 |
| D-06 | Prisma 固定**稳定 7.x**(不使用 `latest` 标签当前指向的 8.0.0-rc) | 避免 RC;事务 API 以固定版本文档为准 | 8.x 稳定后单独评估升级 |
| D-11 | 下载用**用户会话**在 Storage RLS 下签发短时 URL,Web 不持有 Supabase secret key | 少一个 Web 侧秘密;RLS 作为第二层 | 实测不可行 → Web 持有范围最小的服务端凭据(更新秘密清单与威胁模型) |
| D-12 | Webhook 端点只"验签+持久记录",处理由 worker 异步完成;成功页可触发按需核对 | Stripe 文档:快速 2xx、异步队列处理;收到≠处理成功 | 无 |
| D-13 | 付费 bucket 周期键 = `(stripeSubscriptionId, 订阅条目 period_start)` | Stripe 无单独"周期 ID";条目周期来自已验证的订阅对象 | 若发现更稳定的标识(如周期发票 ID)再评估 |
| D-14 | 内部成本核算用整数微单位(`*_micros`) | LLM 成本需亚分精度;不用于向客户计费 | 无 |
| D-22 | TypeScript 5.9.3、ESLint 9.39.5(不用 `latest` 的 TS 7 / ESLint 10) | 跟随官方 `create-next-app@16.4.2` 脚手架实际使用的主版本;ESLint 9 在 npm 上被标记 deprecated,已知 | 评估 Next/eslint-config-next 对 TS 7 / ESLint 10 的支持后升级 |
| D-23 | 不启用 `cacheComponents`/`partialPrefetching`;不用 Google 托管字体 | 私有按用户页面避免意外缓存;构建不依赖外部字体网络 | 需要时再按页面评估缓存策略 |
| D-24 | 本地 Supabase:邮箱确认开启、禁用匿名登录;暂不启动 Realtime/Studio/Storage/Edge/Analytics;`supabase` CLI 作为固定版本的开发依赖 | 满足"验证邮箱"滥用控制;减少镜像体积;版本可复现 | P2 需要 Storage 时再启用 |
| D-25 | 令牌验证只接受非对称算法;应用账户在 `getUser()` 确认邮箱后才创建 | HS256 共享密钥可伪造任意用户(实测);防止未验证邮箱获得免费额度 | 无 |
| D-26 | 开发时应用连接 Supabase 的 Postgres(54322)用 `web_login`(app_runtime);迁移用 `postgres` 所有者(`MIGRATION_DATABASE_URL`);集成测试用 compose 的独立 Postgres | 运行凭据与迁移凭据分离;真实 Supabase 边界测试 | 无 |
| D-27 | Worker 用 `tsx --conditions=react-server` 运行,以便复用带 `server-only` 的 DAL;`tsx` 固定版本 | `server-only` 在 React server 条件下解析为空模块,避免为 worker 复制一份 DAL | Phase 2 若改为编译产物运行,同样保留该条件 |
| D-28 | 对象存储与编译在 Phase 1 通过端口注入,仅有本地磁盘/骨架实现;孤儿对象清理推迟到 P3-T1 | Phase 1 只验证控制流与结算;真实 Storage 适配器在 Phase 2 | 无 |
| D-29 | 应用边界(Server Action、Route Handler、页面)用 `domainErrorCode()` 判断领域错误,不用 `instanceof` | Next.js 对服务端组件和路由处理器分别打包,各有一份错误类;`instanceof` 在 Route Handler 中失效,导致他人任务返回 500(E2E 发现) | 无 |
| D-15 | 括号/分配律等不进入首个验收切片 | 缩小可验证覆盖,先证明流水线 | 首切片验收后独立评审扩展 |

## 3. 未确定且影响上线的决策(需要用户/业务输入)

| ID | 问题 | 推荐默认值(未经确认,仅作为起点) | 阻塞什么 |
|---|---|---|---|
| D-07 | 有有效订阅且 paid bucket 用尽、但试用仍有剩余时,是否回退使用试用? | **不回退**(保守:订阅期间只用付费 bucket;避免"叠加";CLAUDE.md "paid first / 不叠加"的保守解读) | Phase 3 额度选择逻辑与文案 **已采纳(2026-10-18,用户接受推荐默认值)** |
| D-08 | 账户删除后重新注册能否重置试用?是否保留邮箱 HMAC 墓碑? | 保留 HMAC 墓碑(盐值保密)并在隐私政策披露;**不承诺每个自然人 3 次** | Phase 3 账户删除;隐私政策 **已采纳(同上)** |
| D-09 | 账户删除时订阅:立即取消还是期末取消?是否退款? | 立即取消、不自动退款(例外人工处理) | Phase 3 删除流程;服务条款 **已采纳(同上)** |
| D-10 | 退款/争议后的权益:暂停新付费预留?已消耗是否追回? | 暂停新付费预留并人工复核;不追回已消耗 | Phase 3 Stripe 事件矩阵 **已采纳(同上)** |
| D-16 | 价格、币种、每期生成额度 | 无推荐;测试值标注 `TEST VALUE` | 上线(不阻塞开发) |
| D-17 | 目标课程/市场、课件语言、纸张(目标课程:见 §7 D-30) | 英文/Letter(D-01 已更正,见 D-70),不声称对齐任何考试局 | 上线文案与模板 |
| D-18 | 数据地区、保留期、隐私政策与服务条款、子处理方清单 | 无推荐 | 上线 |
| D-19 | 速率/并发/成本阈值、`maxAttempts`、修复次数 | 先用保守配置值;以真实成本数据确定 | 上线 |
| D-20 | Worker 主机提供商与规格、备份套餐/PITR | **staging 主机(部分已定,2026-10-20)**:DigitalOcean Droplet,Ubuntu 24.04 LTS,**4 GB / 2 vCPU**(仅 CPU 与 RAM 的可逆调整;512 MB 实测不够,见 D-57)。**仍待定**:生产的提供商与规格、备份套餐/PITR、gVisor/Firecracker 兼容性(未评估)、编译耗时的系统测量(只有 §7 的一次 10 分钟测试套件时间,不是生产负载) | staging 已选;生产待定 |
| D-05 | 是否从 pdfLaTeX 切换 XeLaTeX/LuaLaTeX | 仅当确认非拉丁语言需求 | 多语言扩展 |
| D-21 | Stripe 受限 key 权限集、API 版本固定值 | Phase 3 对照官方文档与 SDK 确定 | Phase 3 |

## 4. 推荐的下一步

1. 用户已接受 D-07/D-08/D-09/D-10 的推荐默认值(2026-10-18);其余 §3 项仍待用户输入或实测。这些默认值仍须在 Phase 3 实现并测试后才算落实。
2. 用户授权后进入 Phase 1,首个任务是 **P1-T0 环境前置核对**,随后 P1-T1 固定工具链(见 [implementation-plan](implementation-plan.md) §2)。
3. 同时在 Phase 2 前尽早安排沙箱 spike 所需的机器(D-20),因为它决定能否满足 CLAUDE.md 的隔离要求。

## 5. 已核对的官方资料(核对日期:2026-10-18)

核对方式:通过网页抓取工具读取并由摘要模型提炼,**属于二手摘要,关键细节须在对应任务开始前对照原文复核**。

| 资料 | 采用的结论 | 状态 |
|---|---|---|
| [Next.js Data Security](https://nextjs.org/docs/app/guides/data-security) | 数据访问层(仅服务端、做授权、返回 DTO);Server Action 可被直接 POST,须在 action 内重新认证与授权;Origin/Host 比较与 `allowedOrigins`;`server-only`/taint;`proxy.ts` 与 `route.ts` 需重点审计 | 已读取 |
| [Supabase × Prisma](https://supabase.com/docs/guides/database/prisma) | 建议自建 `prisma` 角色,文档所示角色带 `bypassrls`/`createdb`(**本项目不照抄**);无服务器场景:应用用事务池(6543, `pgbouncer=true`),迁移用直连/会话池(5432);该文档对 RLS 说明很少 | 已读取 |
| [Supabase Storage 基础](https://supabase.com/docs/guides/storage/buckets/fundamentals) | 桶默认私有;私有桶的访问由 `storage.objects` 的 RLS 控制;可用用户 JWT 下载或 `createSignedUrl` | 已读取;secret key 行为该页未覆盖,**待验证** |
| [Supabase Next.js 服务端认证](https://supabase.com/docs/guides/auth/server-side/nextjs) | `getClaims()` 验签用于保护页面与数据;`getSession()` 不可用于服务端授权;Next 16 的 `proxy.ts` 刷新会话;避免缓存带 Set-Cookie 的响应 | 已读取 |
| [Stripe webhooks](https://docs.stripe.com/webhooks) | 必须用原始 body 验签;库默认容差 5 分钟;应先返回 2xx 再做复杂处理;重试:生产最多 3 天指数退避;不保证顺序;用事件 ID 去重,同一对象可能有两个不同事件;建议异步队列处理 | 已读取 |
| [Stripe 订阅 webhooks](https://docs.stripe.com/billing/subscriptions/webhooks) | `invoice.paid` 后应读取订阅确认 `active` 再延长权益;`active` 不必然表示所有发票已付;`canceled`/`unpaid` 撤销访问;`canceled` 为终态;`incomplete` 需 23 小时内付款 | 已读取 |
| [Stripe changelog:订阅周期字段](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end) | 自 `2025-03-31.basil` 起 `current_period_start/end` 从订阅对象移除,改在订阅条目上 | 已读取;固定 API 版本时再核对,待验证 |
| [Vercel Functions 限制](https://vercel.com/docs/functions/limitations) | 最大时长:Hobby 300 s;Pro/Enterprise 默认 300 s、上限 800 s、Beta 1800 s;请求/响应体 4.5 MB;无 TeX 与隔离控制 | 已读取(页面更新于 2026-08-24) |
| [Docker 安全](https://docs.docker.com/engine/security/) | 容器隔离依赖共享内核;默认能力与挂载在配合内核漏洞时可能隔离不完整;`dockerd` 默认 root;建议非 root、丢弃能力、userns、seccomp/AppArmor | 已读取 |
| [gVisor](https://gvisor.dev/docs/) | 用户态应用内核(Sentry),系统调用不直通宿主;`runsc` 兼容 Docker/OCI;代价:兼容性与系统调用开销 | 已读取(摘要未确认具体平台:systrap/KVM,**待验证**) |
| [TUG TeX Live 已知问题](https://tug.org/texlive/bugs.html) | — | **抓取失败(403)**,未核对;TeX Live 年份、`shell_escape`/`openin_any` 行为须在 Phase 2 对固定版本实测 |
| Prisma 事务文档 | 本次抓取到的页面描述的是**新主版本**的事务 API(与稳定 7.x 不同) | **不得套用**;Phase 1 固定 7.x 后读取对应版本文档 |
| npm registry(2026-10-18) | next 16.4.2、prisma `latest`=8.0.0-rc.23(稳定 7.10.1)、stripe 23.0.0、@supabase/ssr 0.12.7、@supabase/supabase-js 2.118.0、zod 4.6.7、vitest 5.0.5、@playwright/test 1.64.1、tailwindcss 4.3.3;Prisma 要求 Node `^22.18 \|\| ^24.11 \|\| >=26` | 仅供选型;P1-T1 重新核对后固定 |
| Fly.io Machines(搜索结果) | 基于 Firecracker;按秒计费 | 仅作为替代 B 的线索;沙箱加固能力**未核实** |
| TeX Live 发行(搜索结果) | 社区镜像称 ≤2025 已冻结、存在 2026 标签;**未**核实官方发行状态 | **待验证** |

## 6. CLAUDE.md 一致性检查

- 2026-10-19:`CLAUDE.md` 已按新产品方向修订(输入为选择、三份文档、预览+调整取代编辑器、`.tex` 不对外、课程对齐只来自数据集、调整计费、管线增加课程上下文与规划)。依据与逐条对照见 [refactor-audit](refactor-audit.md) §5.2。此前(2026-10-18)未修改。
- 发现的模糊点(不属于矛盾,未改文件):§5 中 "paid bucket first" 与 "不叠加" 的组合没有说明 paid bucket 用尽后是否回退试用 → 记为 D-07。账户删除后重新注册是否重置试用未规定 → 记为 D-08。

## 7. 2026-10-19 产品方向调整的决定

背景:产品改为**选择优先、课程感知、预览+调整**(见 [product-vision](product-vision.md)、[refactor-audit](refactor-audit.md)、[curriculum-architecture](curriculum-architecture.md)、[refactor-plan](refactor-plan.md))。状态说明:**已批准** = 用户明确答复;**需求已含** = 用户的需求说明已规定;**临时默认** = 我的推荐,**尚未经用户确认**,实施到相关里程碑之前仍可更改。

| ID | 决定 | 状态 |
|---|---|---|
| D-30 | MVP 的目标课程是 **Ontario Grade 9 数学**;**真实课程数据集是之后的独立里程碑(CM)**,不阻塞其余基础设施。此前只允许**明确标注的示例数据集**(仅开发/staging,界面标注"示例,非真实课程",**不得产生对齐声明**) | **已批准**(2026-10-19);**2026-10-21 补充(D-74)**:Beta 改用自有的"NotePrep 主题"数据集、以主题为先,真实课程数据集不再阻塞 Beta |
| D-31 | **不向用户提供 `.tex`**;只导出 PDF;`.tex` 是内部派生物(调试与重新渲染) | **已批准** |
| D-32 | 文档集合:Tutor Lesson Notes / Student Practice Worksheet / Solutions;完整生成 = 所请求文档的 PDF 全部成功 | 需求已含 |
| D-33 | 调整计费方案 B:**不调用模型的确定性调整**不是新生成(受速率与计算配额限制);**含模型的调整**消耗每课包的调整额度(配置值,与生成次数分开),成功才消耗、失败返还、一次结算。**每课包调整额度的默认值待定** | **已批准**(默认值待定) |
| D-34 | 手动更正仅限文字字段,不改数学内容 | 需求已含("极小的手动更正") |
| D-35 | 不受支持主题:灰显 + 原因;服务端拒绝;可选记录"想要此主题"(仅 profile + topic);不开放自由文本主题 | 临时默认 |
| D-36 | 课程文本策略与授权:只存标识符 + 自己的释义 + 来源引用;是否需要授权由用户/法务确认。**推迟到与 D-30 真实数据集相同的里程碑(CM)决定** | **已推迟**(同意) |
| D-37 | `/lessons/new` 旧表单:新流程通过验收后隐藏入口,M7 删除 | 临时默认 |
| D-38 | 输出包可选子集(至少一份),无论选几份都算一次生成 | 临时默认 |
| D-39 | 语言:英文;不做法语 | 临时默认 |

**对既有决定的影响**:D-17(目标课程/市场)的"目标课程"部分由 D-30 回答;D-16(价格/币种/额度)、D-18(数据地区/隐私)、D-19(阈值)、D-20(Worker 主机)仍待定。D-02(pdfLaTeX 模板)现在要为**三份**文档各设计一个固定模板。

## 8. 2026-10-19 M3b 的决定

| ID | 决定 | 状态 |
|---|---|---|
| D-40 | 第一个真实 LLM 适配器选 **Anthropic Messages API**(用户未指定供应商;接口与供应商无关,换供应商只需新增适配器)。模型 ID 与两项单价**必须由配置提供,仓库不含默认值**(官方文档未给出价格,不得凭记忆写) | 临时默认,**待用户确认供应商** |
| D-41 | 模型只写五段纯文字;数学、题目、答案、课程声明永远来自代码与数据集;不合格输出带规则代码修复一次,仍不合格回退到模板文字,课包照常完整并算一次生成 | 已实现 |
| D-42 | `LESSON_PROSE` 默认 `template`:启用模型文字前必须先做一次受控真实评估并把结果记录在此(`pnpm eval:prose`);**评估记录见下方 §8.1**。结论:适配器对真实服务可用,通过率达到可接受水平,但仍缺人工(教师)质量抽查与更大样本,因此默认仍是 `template` | 部分完成 |
| D-43 | 子处理方披露:启用 LLM 后,供应商会收到每节课的概念名、学习目标与先备主题措辞、难度与课时;不含账户、账单、课程名/编码、其他用户内容。保留期与训练政策以供应商官方条款为准,**不自行承诺零保留** | 已写入 security-and-privacy |

### 8.1 M3b 真实评估记录(2026-10-19,模型 `claude-haiku-5-5`)

条件:`pnpm eval:prose`,虚构的课程上下文(无真实课程文本、无用户数据),难度 basic/mixed/challenge 轮换,课时 45/60/90 轮换;一次评估调用最多 2 次请求(含一次修复)。**价格取自用户配置(输入与输出单价配置值相同,均为 3000000 微单位/百万 token,与官方价格表未核对),所以成本数字只在该配置下成立。**

| 批次 | 运行数 | 首次通过 | 最终通过 | 回退到模板 | 每次成本(微单位) | 中位延迟 |
|---|---|---|---|---|---|---|
| 1 | 3 | 2 | 2 | 1(`PROSE_META_TEXT`) | 约 10,056 | 约 12.2 秒 |
| 2 | 6 | 5 | 6 | 0 | 约 8,634 | 约 9.0 秒 |
| 3 | 9 | 6 | 9 | 0 | 约 10,391 | 约 10.8 秒 |
| 4 | 9 | 5 | 9 | 0 | 约 10,496 | 约 10.9 秒 |
| 修复后 5 | 12 | 11 | 12 | 0 | 约 7,422 | 约 8.9 秒 |

**发现的问题与处理**(均由真实评估暴露,模拟测试和假提供方都发现不了):
1. **长度**:模型不数字符,常常略微超过提示里的 400 字符上限(观察到 408、411、603、775)。结果:约 28% 的请求需要修复。处理:硬上限放宽到 600(与课包自身的段落上限一致),提示仍要求 400;修复请求现在带具体的 `TOO_LONG:字段` 之类的代码,而不是笼统的"形状错误"。效果:首次通过率从约 72% 升到 92%(样本小)。
2. **误报**:`PROSE_META_TEXT` 把"prompt them to check answers"这种正常教学用语当成指令注入。处理:规则只保留短语"system prompt",不再匹配单独的 `prompt`,并加了回归测试。
3. **成本**:每次约 1,500 个输出 token,而稿子本身约 600 个,说明默认的自适应思考占了大头。**未设置 `thinking`/effort**;如果成本成为问题,下一步是按模型可选地关闭或降低思考(文档说明 Haiku 5.5 接受 `disabled`,Sonnet 5.5 不接受)。

**人工抽查**:助手读过一份完整输出(解释、推导、教学顺序、常见错误):措辞准确、无数字/符号/课程声明,内容与"一元一次方程"相符。**这不是教师或数学审核**;启用前仍需要你(或一位教师)抽查若干份,尤其是教学顺序和常见错误是否合理。

**样本局限**:模型只测了 Haiku 5.5;共 39 次运行;只有一个虚构上下文;没有对 Sonnet 5.5 做对比;没有测试拒绝或服务故障的真实表现。**结论**:可以在 staging 上以 `LESSON_PROSE=llm` 做试用,但在人工抽查完成前,生产默认保持 `template`。

## 9. 2026-10-19 M4 的决定

| ID | 决定 | 状态 |
|---|---|---|
| D-44 | 首版沙箱 = 每次编译一个全新容器,runc + 默认 seccomp + 全套限制(见 README M4);**gVisor 不在本地使用**。是否在生产主机上启用 gVisor/改用 Firecracker 取决于 D-03/D-20 与目标主机上的实测,**仍待定**;在那之前,生产上线要求在目标主机上重跑 `pnpm test:latex` | 已实现(本地);生产待定 |
| D-45 | PDF 对象压缩在模板里关闭,宿主拒绝任何含对象流或活动内容的 PDF(而不是解析 PDF);这是为了让"扫描字典"有意义 | 已实现 |
| D-46 | 模板 `classic/1`:Letter 纸、英文、拉丁字符集;一个模板、一个引擎(pdfLaTeX / TeX Live 2022);换纸张/语言/字体需要新的模板版本 | 已实现(沿用 D-39 临时默认) |
| D-47 | 镜像的 TeX 包版本记录在 `packages.lock` 并由测试核对;基础镜像摘要固定;生产 `LATEX_IMAGE` 必须是 `@sha256:` 摘要 | 已实现 |

## 10. 2026-10-19 M5 的决定

| ID | 决定 | 状态 |
|---|---|---|
| D-48 | 预览/下载走 Route Handler:DAL 授权 → **用户会话**签发 60 秒签名 URL → 302;Web 不持有 Storage secret key。Storage RLS 是第二道检查,**只检查"自己的前缀 + `.pdf` 扩展名"**(`.tex` 用户读不到,D-31);它不知道课包是否已删除或修订是否已发布,这些由应用路由强制(账号 active、课包未删除、修订已完成、清单含该文件)。**已知限制**:课包删除上线时要把删除/发布状态也纳入对象访问控制(或在删除时同步移除对象);此前不改 RLS 策略。采用签名 URL 而不是经 Web 转发字节,是为了不受 Vercel 响应体大小限制,并让 URL 自然到期 | 已实现并实测 |
| D-49 | 预览用浏览器自带 PDF 查看器(`<iframe>`),始终附"新标签页打开/下载"降级链接;不引入 PDF.js 等新依赖 | 已实现;移动端未实测 |
| D-50 | worker 的对象存储用 `OBJECT_STORE=fs|supabase` 选择,默认 `fs`(测试/最小本地),**生产必须 `supabase`**;Supabase 适配器持有 secret key,仅 worker 使用 | 已实现 |
| D-51 | 所有预览/下载/标签链接显式带 `rev`,服务端只接受"属于该课包且属于该所有者的已完成修订";对象路径只取自该修订的清单 | 已实现 |

## 11. 2026-10-20 Worker 部署的决定(staging)

> 状态说明:"已实现(未在主机验证)" = 文件、脚本和仓库内测试已存在;**没有任何一项在真实 Linux 主机上运行过**。操作步骤见 [worker-host-runbook.md](worker-host-runbook.md)。

| ID | 决定 | 状态 |
|---|---|---|
| D-52 | **主机拓扑**。比较过:① 把 `/var/run/docker.sock` 挂进 worker 容器 = 等同 root,**拒绝**;② systemd 服务 + 账户在 `docker` 组 = 等同 root,**拒绝**;③ worker 与 rootless Docker 同一账户:沙箱逃逸会落在持有全部秘密的账户上(同 uid 可读 `/proc/<pid>/environ`),违背"runner 无秘密",**拒绝**;④ **选用**:worker 容器(uid 10001、只读根、无能力)由宿主 rootful Docker 运行;沙箱由 `noteprep-runner`(nologin、无 sudo、不在 docker 组)的 rootless Docker 运行,socket 放在 `/run/noteprep-runner/`(0750,组 `noteprep-runner`),仅该**目录**以只读方式挂进 worker 容器并 `--group-add` 该组(挂目录而不是 socket 文件,使 runner 守护进程重启后无需重启 worker)。worker 容器的秘密由 root 守护进程持有,runner 读不到。rootless 守护进程的 drop-in 由 root 拥有、安装在 `/etc/systemd/user/docker.service.d/`,使预期参数由 root 控制且可审查;这**不能**阻止 runner 在 `~/.config/systemd/user` 下覆盖自己的用户级单元(用户目录优先),runner 不在威胁模型里获得比它本来就有的更多权限。runner 不持有任何注册表凭据:root 拉取镜像,LaTeX 镜像经 `docker save \| docker load` 送入 runner 的守护进程(或把该镜像设为公开);worker 镜像只按摘要引用(单元用 `--pull never` + `ExecStartPre` 摘要守卫强制)。日志只走 `journalctl -u noteprep-worker`(容器 `--log-driver none`)。**它保护什么**:worker 被攻破 ≠ 宿主 root;沙箱逃逸落在无秘密的 runner 账户。**它不保护什么**:① 共享内核(内核漏洞可从沙箱或 worker 直达宿主 root,没有 gVisor);② worker 被攻破时攻击者拥有全部 worker 秘密(worker DB 角色、Storage secret key、LLM key),并能用 runner 守护进程消耗资源、篡改其他正在编译的作业产物、经 rootless 网络出站;③ 逃逸到 runner 的攻击者同样能篡改并发作业的 PDF(宿主只检查格式与活动内容)、占满磁盘;④ runner 账户没有出站防火墙;⑤ 宿主 root 可经 `docker inspect` 看到 worker 秘密(只限管理员)。**生产还需要(不在本计划内)**:在目标主机上评估 gVisor `runsc`(与 rootless 的兼容性未验证)或 Firecracker(D-03/D-20);runner uid 的 nftables 出站拒绝;镜像签名/来源证明;告警系统;在生产主机重跑 `test:latex`(D-44) | 已实现(未在主机验证) |
| D-53 | **镜像内容**。esbuild 打包 `worker/main.ts` 与 `worker/healthcheck.ts`(显式 external 列表:`@prisma/client`、`@prisma/adapter-pg`、`pg`、`pg-native`,其余全部打进包;镜像只复制这些包的依赖闭包,见 `scripts/build-worker.mjs` 与 `scripts/copy-externals.mjs`;`conditions: ["react-server"]`),运行时 `node --conditions=react-server`;生产依赖 `pnpm install --prod --frozen-lockfile --ignore-scripts`(Prisma 客户端已打进包,不需要 postinstall);删除 npm/corepack/yarn;`USER 10001:10001`;镜像不含任何秘密。基础镜像按 linux/amd64 清单摘要固定(查询日期 2026-10-20,`docker buildx imagetools inspect`):`node:24.13.1-bookworm-slim` → `sha256:85a395c77b811fa7f5b5e4aa69cd6eb4c3b80c7f1a8e34704dc0ce061e5b404e`;`docker:29.8.2-cli` → `sha256:d329fa64f42e03248f9a6cb2e21b6d4aa4d76f5a80aa2ad7946d81fbf1860602`(值与 `docker/worker/Dockerfile` 头部一致)。同一 Dockerfile 的 `hosttest` 目标随 worker 镜像一起按摘要发布,用于在主机上跑沙箱测试 | 已实现(未在主机验证) |
| D-54 | **发布**。手动工作流 `images.yml`(仅 main)只用 runner 自带的 docker CLI 与 `GITHUB_TOKEN`(只在测试之后的 push 作业里出现,该作业不 checkout、不运行仓库代码),不引入新的第三方 Action;镜像以 git SHA 打标签,输出并写入 Step Summary 的是**摘要**,主机只按摘要拉取。`main` 限定只是防误操作,不是访问控制;真正的边界是仓库写权限与分支/环境保护 | 已实现;**托管 Actions 上的真实运行未验证** |
| D-55 | **存活与停止**。worker 在每次成功的 sweep(每 `SWEEP_INTERVAL_SECONDS`,访问数据库)和每次成功的轮询后 `touch` `WORKER_LIVENESS_FILE`;`healthcheck` 检查文件新于 120 s。SIGTERM:停止领取新作业,**让在途作业完成**;宿主停止超时 180 s,超过则 SIGKILL,由租约过期 + sweeper 接管(不扣额度)。Docker 不会因 unhealthy 自动重启:健康状态只用于告警。**局限**:健康检查只证明数据库可达;runner socket 或组映射坏了时 worker 仍然 `healthy`,而每次编译都以 `sandbox_unavailable` 失败,所以告警必须同时监控 `generation_job.error_code='sandbox_unavailable'` 的失败数(SQL 见 runbook §11);Dockerfile 的 HEALTHCHECK 写死 `/run/noteprep/alive`,因此不得覆盖 `WORKER_LIVENESS_FILE` | 已实现(未在主机验证) |
| D-56 | **staging 冒烟**。Playwright 走**真实登录表单**(而不是脚本里用 Supabase 密码流程伪造 `@supabase/ssr` 的 Cookie,也不调用 Server Action):不依赖库的内部 Cookie 格式、不需要任何 key,测的就是用户路径。目标是白名单(只允许 `https://noteprep.app`),trace/截图/视频关闭。每次运行消耗测试账户 1 次免费生成;账户为一次性 staging 用户,额度用完就换新用户(额度绝不重置) | 已实现;**对真实 staging 的运行未验证** |
| D-57 | **第一台真实 staging 主机的实测发现(2026-10-20,DigitalOcean / Ubuntu 24.04 / Docker 29.9.1)**,对 D-52 的修正与补充:① rootless 守护进程必须用 `--group 0`:`--group noteprep-runner` 在用户命名空间里是未映射的 gid,socket 组显示为 `UNKNOWN`(`660 noteprep-runner UNKNOWN`);`--group 0` 对应 runner 自己的主组,得到 `660 noteprep-runner noteprep-runner`,整机重启后不变;`deploy/host/runner-docker.conf` 与其单元测试已改。② 主机至少 **4 GB / 2 vCPU**:512 MB 上全局 OOM 杀掉了 runner 的 `dockerd`,§7 的 41 个测试里 9 个失败;改为 4 GB / 2 vCPU 后 41/41 通过。③ DigitalOcean 的元数据端点(`169.254.169.254`)与宿主 sshd(经 `172.17.0.1:22`)默认都能从 worker 容器到达;新增 `deploy/host/noteprep-block-metadata.service`(`DOCKER-USER` 与 `INPUT` 上的 iptables 规则,启动时在 worker 之前套用,重启后验证过)。它**只**保护 worker 容器,不保护 runner 的 rootless 网络。④ `dockerd-rootless-setuptool.sh install` 末尾的就绪探测因 socket 被移走而报错,无害(守护进程已在运行)。⑤ `worker.env` 里变量名拼写错误(`COMPLIER`)会让 worker 以 `COMPILER must be docker in production` 拒绝启动,而 `docker run --env-file` 不会报告未知变量名,所以拼写错误只能靠 worker 自己的配置校验发现;`worker.env` 不要加引号(`--env-file` 不去引号)。⑥ 拉取 GHCR 私有镜像需要经典 PAT(`read:packages`);LaTeX 镜像按"做法 B"设为公开,由 runner 的守护进程直接拉取。⑦ **改 `worker.env` 后必须重启单元**:更新 `SUPABASE_SECRET_KEY` 却没有重启时,worker 仍用旧密钥,每次生成都以 `storage_failed` 失败(UI 文案"The finished files could not be saved.");用密钥的哈希指纹核对容器里的值(runbook §4),不要打印密钥。⑧ `StorageError` 不带 HTTP 状态与消息,所以密钥错误、桶缺失、上传失败在 UI 与日志里不可区分;现在 worker 在 `job_failed`/`job_requeued`/`attempt_cleanup_failed` 里记录 `storageOp`/`storageStatus`/`storageMessage`(单行、至多 200 字符,类似密钥或 JWT 的文本被替换为 `[redacted]`,不含路径;单元测试覆盖清洗与字段,**日志行本身没有集成测试**)。staging 主机要发布并部署新的 worker 镜像后才有这些日志。手写 curl 不能用来判断新式 `sb_secret_` 密钥好坏(它不是 JWT),要用同版本的 supabase-js 测。2026-10-20 重启后,在 `https://noteprep.app` 上手动生成成功一次(`fake` LLM、`template` 文稿)。**未验证**:LaTeX 镜像经 `docker save \| docker load` 后的摘要引用(做法 A)、`dbus-user-session` 是否必需、cgroup v1、runner 的 rootless 出站、生成进行中的优雅停止、对真实 staging 站点的冒烟 | 已在主机上验证(上述各点);其余 UNVERIFIED |
| D-58 | **Figma 是视觉占位稿,功能以产品约束与代码为准**:设计里的示例数据(Ontario Grade 12 / MCV4U、Jane Doe、缩略图、"Studio" 等)只是占位;与 CLAUDE.md 或已批准决定冲突时,功能优先,界面按设计系统重新表达(2026-10-20) | **已批准**(用户) |
| D-59 | **输出类型 = 现有三份文档**(Tutor Lesson Notes / Student Practice Worksheet / Solutions),按 D-38 任意子集;**不做 Quiz**。Figma 的 "Material type" 三选一改为这三份文档的多选卡片 | **已批准**(用户) |
| D-60 | **预览双轨**:应用内的**实时 HTML 预览**(由同一份结构化内容渲染,用于编辑与调整时即时反馈)+ **编译出的 PDF 作为权威的最终导出物**。这**修改了 CLAUDE.md §7 的"预览就是编译 PDF"**。约束:HTML 预览带"草稿预览,以导出的 PDF 为准"标注;与 PDF 使用同一 `revisionId`;数学只渲染已验证内容,KaTeX 宏受限、不渲染不受信 HTML/URL;**新增 KaTeX 依赖需固定版本**;真实 PDF 标签页保留(导出前可查看);测试:同一修订下 HTML 与 PDF 的文本/题目 ID 一致 | **已批准**(用户);实现 U4/U6 |
| D-61 | **保留"预设调整",暂不做逐题调整**(2026-10-20 修订):编辑器只做 M6 的文档级预设调整(更容易/更难、增加例题/练习题、减少理论、展开分步解答、聚焦目标、更改课时)与**文字字段**的极小更正(D-34);Figma 的逐题 Edit / Regenerate / Remove / Add、单题难度、"换一个同类题"、撤销删除**暂不做**,之后另立决定。数学内容仍不可手改,只能确定性重新生成。依赖 M6 与 D-33 计费 | **已批准**(用户);实现 U6;**2026-10-21 部分反转(D-71)**:增加"换掉这一题"与"删除这一题" |
| D-62 | **定价区按我们原本的模型**:3 次终身免费 + 一个月度订阅;金额、币种、每期额度来自配置并标注 `TEST VALUE`(D-16 仍待定);不做多档、不做 Studio/团队 | **已批准**(用户);**2026-10-21 修订(D-83)**:界面占位改为三档预览价格,后端仍只有一个付费计划 |
| D-63 | **课程可配置**:界面上的课程、级别、课程、单元、主题与文案全部来自已加载的数据集;新增课程只需加载数据集,不改 UI 代码;"Subject" 仅在数据集提供时显示 | **已批准**(用户) |
| D-64 | **营销文案可以提 LaTeX**(假定用户知道这个概念,但不需要会用);界面仍不让用户编写/编辑 LaTeX,不提供 `.tex`(D-31 不变) | **已批准**(用户) |
| D-65 | **M6 第一版范围(2026-10-21 批准,见 `docs/superpowers/plans/2026-10-21-m6-adjustments.md`)**:预设调整只做确定性动作——更容易、更难、增加练习、增加例题、更改课时——外加文字字段的极小更正;"展开分步解答""减少理论(LLM)""聚焦目标"推迟(前两者需要新的可验证步骤类型或 LLM;"聚焦目标"目前没有确定性含义)。增加练习保持课时与计时不变。更正中禁止出现数字。调整与更正**永不**消耗 3 次免费生成(由数据库触发器强制) | **已批准**(用户) |
| D-66 | **每课包的 LLM 调整额度**:默认 5 次(`TEST VALUE`,配置键 `ADJUSTMENT_LLM_BUDGET_PER_LESSON`),在该课包首次使用时固定上限;失败/取消返还,成功才消耗,一次结算;**丢弃草稿不退还**;第一版没有调用模型的动作,此额度先作为基础设施(默认关闭 `ADJUSTMENT_LLM_ACTIONS=0`) | **已批准**(用户) |
| D-67 | **草稿语义**:调整与更正产出经验证、渲染、沙箱编译的完整草稿修订;可在草稿上连续叠加再一次接受;接受前可预览并下载草稿 PDF(文件名标 draft);有作业进行中时禁止接受或丢弃;界面显示"第 N 个已接受版本"(内部 `number` 允许跳号);丢弃的草稿对象保留到课包删除。订阅过期后,确定性调整与更正仍可使用,已发放的课包额度仍可用 | **已批准**(用户) |
| D-68 | **调整的速率与并发(开发默认,`TEST VALUE`)**:每用户 30/小时、150/日;每 IP 60/小时;每课包同时 1 个调整作业;每用户同时 2 个 | **已批准**(用户) |
| D-69 | **M6 S1 已实现的行为与待确认项**(2026-10-21,分支 `feat/m6-core`;以下五项是 S1 代码当前的行为,**均未经批准**,请负责人确认或改定):(1)**更改课时**:只要新课时算出的练习数或例题数与课包当前数量不同(哪怕 60→61 分钟),就把整组练习或整组例题重新抽取,先前"增加练习/增加例题"加进来的内容会被丢弃;只有数量相同时才保留。编辑界面必须事先提示。(2)**新增或重抽的例题难度**:按例题节原来的水平抽取(basic 仍为 basic,其他一律 mixed,不做由易到难的梯度);例如 basic 课包先"更难"再"增加例题",得到的仍是简单形式的例题。建议:改为按课包当前的有效难度抽取。(3)**更正的词表代价**:为了禁止数字,导师不能写 `work in pairs`、`a single step`、`double check`、`half`、`decade`、`trio`、`the right one`、`pick one example`、`more than one method` 以及大写的 `MIX`、`XL`、`CD`、`MD`、`DC`、`CM`、`MM` 等(完整规则见 M6 计划 §2.6)。(4)**在 MIXED 练习组上"增加练习"**:新题都按 mixed 水平追加在最难的题之后,整组不再以最难的题结尾。(5)**导师改过的节**:之后再被重新生成(更难/更容易/增加练习/更改课时/增加例题)时,保留 `edited:true` 与 `provenance.method='tutor_edit'`(以及 LLM 的 model/promptVersion),只更新 seed、difficulty、generatorVersion;已在 S1 实现,请确认。**已实现的限制**:一个课包最多 200 条 `adjustments` 记录(schema 上限);达到 200 条后所有动作都被拒绝,原因 `max_adjustments` | **已确认**(用户,2026-10-21):(1)(3)(5)按现状接受,不改代码;(2)(4)按建议改,见 D-72 |
| D-70 | **Beta 语言与纸张(修订 D-01/D-17)**:Beta 只做**英文 + Letter**(D-46 已实现 Letter;D-01 原写的 A4 作废)。**本地化(l10n)是 Beta 信号之后的独立里程碑**:界面的语言下拉(法语等)只对有该语言版本的课程提供;届时需要 `locale` 成为真实设置(目前 `z.literal("en")`)、按语言的字符串表、法语数据集(另走 D-36 授权检查)、`babel` 与法语编译测试、法语的文字规则与夹具、会法语的数学审阅者。"至少 3 位导师要求法语"是提前排期的信号。B1 里新增的模板文字若成本很低,集中放进一张表 | **已批准**(用户,2026-10-21) |
| D-71 | **部分反转 D-61:Beta 增加"换掉这一题"与"删除这一题"**(B2)。仍不做单题难度修改、撤销删除。约束:替换保持同一 `skill`/`level` 并用指纹排除已用题目;删除保留最低练习数;答案按 `questionId` 配对;两者都计入 200 条记录上限;是确定性调整,不消耗生成额度,受速率限制,并防止"整卷替换"成为免费重新生成 | **已批准**(用户,2026-10-21);实现 B2 |
| D-72 | **D-69 的结论(2026-10-21)**:(1)Beta 界面**隐藏"更改课时"**(核心代码保留;日后启用前须在界面提示会丢弃已增加的内容)。(2)新增/重抽的例题按**课包当前的有效难度**抽取(梯度推迟,可能在 B1)。(3)**保留更正词表规则**,文字更正(S5)与更正抽屉**推迟到 B6**。(4)混合练习组上的"增加练习"把新题**插在最难的题之前**;"无关题目逐字节相同"的测试需允许位置顺移(`id` 与配对不变)。(5)导师改过的节再生成时**保留** `edited:true` 与 `tutor_edit` 溯源。(2)(4)在合并 `feat/m6-core` 之前需要小的核心改动 | **已批准**(用户,2026-10-21) |
| D-73 | **Beta 方式、定位与顺序**:(a)先做**礼宾式(concierge)**——约 5 位导师、真实课程、每周访谈、在 staging 上由你操作——之后再开放免费的邀请制自助 Beta;(b)首页主张:**"几分钟得到完整、可直接打印的课包;调整不会破坏答案册"**,"数学已验证"作为辅助证明,直到访谈与"ChatGPT 答案册出错率"实验给出数据;(c)顺序:**B1(题目质量)先于 B2(调整闭环)**,Stripe 在 Beta 信号之后。里程碑 B0–B6 的路线图目前只在已批准的策略计划中(尚未写入仓库文档);相关决定见 D-74 至 D-84 | **已批准**(用户,2026-10-21) |
| D-74 | **选题以"主题"为先(修订 D-30/D-36,并修改 CLAUDE.md §1 的措辞)**:Beta 使用**自有的"NotePrep 主题"数据集**(我们自己写,走现有数据集机制,`licenseNote` 写明为 NotePrep 自有);**不做任何课程对齐声明,文案不得写 "curriculum-aligned"**;Ontario Grade 9 只用来决定先做哪些主题(D-30 的目标课程不变,但真实课程数据集与授权 D-36 继续推迟)。允许在测试之外使用这份**真实、非示例**的自有主题数据集。"可选主题必须已验证"不变 | **已批准**(用户,2026-10-21) |
| D-75 | **广度:自助 Beta 提供课程下拉与"未官方建议主题"**:下拉含 ON、BC、AB、IB、AP 等(具体清单在 B3 定);选中后显示该课程的**建议主题**:已可用的可点,其余灰显"暂不可用"并有"申请此主题"按钮与计数("38 个中 6 个可用")。规则:标注"非官方、未获认可";只用课程名作描述性使用,不用标志/官方编码/复制的大纲文字;**从不使用"aligned/对齐"**;每条映射记录依据;映射草稿可由 LLM 辅助、必须人工抽查;**第一次出现 IB/AP 标签前由法律顾问核对措辞**。映射可带"估计/官方"标记(日后设计)。**这把 D-74 的叠加层从"Beta 之后"提前到"自助 Beta"**。礼宾阶段先用灰显主题的原型向 5 位导师测试(是"懂我的课程"还是"没做完");只统计首个主题已可用的导师的激活率,"申请了但不可用"另记 | **已批准**(用户,2026-10-21) |
| D-76 | **学生档案推迟到 Beta 之后**:匿名的、由导师自己写的标签 + 课程标签 + 默认级别/难度,作为第一个留存功能;需要单独的范围与隐私决定,因为 CLAUDE.md §1 排除学生账户/CRM、§9 禁止要求学生姓名(与 D-78 相关)。Beta 不新增学生实体 | **已批准**(用户,2026-10-21) |
| D-77 | **题目引擎方向**:(a)B1 里把主题做成**声明式配置(数据而非代码)**,CI 的**验证扫描**为每个配置生成数千份样卷,通过校验器与独立求解检查,并**生成覆盖台账**;主题只有在台账显示每个提供的难度都通过后才在应用中可用(区分"映射覆盖"与"已验证的生成覆盖")。(b)礼宾阶段菜单 4 个主题:一步方程、两步方程、两边都有未知数、先合并同类项;括号仅在访谈证明需要时做(B1b);**自助 Beta 开放前扩到约 8–10 个已验证主题**(估计,未验证;候选:括号、不等式、代数式求值/化简),B1 需要在选定主题后重新估算。(c)生成方式:保留参数化生成器,**扩展为"题型模板(archetype)"**;LLM 辅助的离线模板创作(必要时才用静态题)作为 **Beta 信号之后的试点**(约 20 个模板,度量通过率与审阅时间),标签为"数学已验证,措辞已审阅";不改成纯题库。质量底线与触发条件见计划的 §D、§G | **已批准**(用户,2026-10-21) |
| D-78 | **隐私与法务的分级最低要求(D-18)**:礼宾阶段——邮件同意 + 一页"我们存什么"说明,不收学生个人信息;自助 Beta——Beta 隐私声明与条款、子处理方清单(Supabase、托管主机、OpenAI、Google 等)、**确定数据地区**(核对当前 Supabase 项目区域)、按请求手动删除;收费或公开上线之前——完整政策与删除流程。PIPEDA / 魁北克 Law 25 的适用性、同意措辞,以及一方使用事件是否算"必要",**须由有资质的人核对**(此处未验证);OpenAI/Google 的保留、训练、地区表述必须取自其当前的实际条款 | **已批准**(用户,2026-10-21) |
| D-79 | **Beta 额度**:邀请/白名单账户使用更大的终身额度(起步约 30,`TEST VALUE`,配置项);预留/结算/围栏的所有不变量不变;每账户并发与速率限制照旧;需要一条针对较高额度的测试(属 B4) | **已批准**(用户,2026-10-21) |
| D-80 | **第二个题型的选择**:由数据决定,不靠猜。"申请主题"入口增加**课程下拉(可选)**,仅作标签、不构成对齐声明;礼宾访谈询问每位导师的学生所学课程。规则:取主导课程序列中的下一个主题簇,按验证成本加权;没有明确信号时默认**线性不等式**。日后学生档案的标签取代这个单独问题 | **已批准**(用户,2026-10-21) |
| D-81 | **LLM 提示文字与提供方**:默认**模板文字**(B1 的主题化措辞会改进它);LLM 文字对少数测试者**自愿开启**,用于比较。产品自己的生成改用 **OpenAI 作为首选真实提供方**,**保留 Anthropic 适配器**(由配置选择)与 fake。小切片(不属 B1):新增 `src/lib/llm/openai.ts`、`LLM_PROVIDER` 枚举(`worker/env.ts`)与 `factory.ts`、适配器测试(注入 `fetch`)、**重新运行 `scripts/eval-prose.ts`**(此前 39 次 Haiku 评估不适用)、更新 `.env.example`/README/architecture;动手前**先对照官方文档核对**结构化输出规则与模型清单(此处未核对);代价是维护两个真实适配器。Claude Code 开发流程不受影响 | **已批准**(用户,2026-10-21) |
| D-82 | **Worker 主机(D-20)**:礼宾与邀请制封闭 Beta 沿用当前 DigitalOcean 主机,并把限制写明(不公开注册;默认模板文字);Beta 之前补做优雅停止、重启、回滚检查与失败/卡住告警(B4);收费或公开上线之前做 gVisor、出站防火墙、镜像签名 | **已批准**(用户,2026-10-21) |
| D-83 | **定价占位(修订 D-62 的"不做多档",D-16 仍推迟)**:价格推迟到有 Beta 数据(访谈中的价格问题、实测每课成本)之后、Stripe 工作开始之前再定。界面把占位改为**三档**(免费 / 中档 / 高用量),标注"预览价格";高档写明**上限而非"无限"**;后端仍只有一个付费计划,多档日后只是配置项(每个计划的额度)。"无限"需要成本决定并对 CLAUDE.md §5 作例外 | **已批准**(用户,2026-10-21) |
| D-84 | **分析与同意**:两层——**GA4**(免费层,限额未核实)用于营销站与一小批白名单应用事件;**一方 `analytics_event` 表**(我们自己的 Postgres)用于决定 Beta 触发条件的指标(激活、回访、打印用时、调整次数、主题申请、每课成本)。规则:单一 `track()` 封装,事件名与参数白名单,其余丢弃;URL 清洗为路由模式(不含课程/作业/修订 ID、不含签名 URL);不设 GA `user_id`、不发邮箱、课程文字或学生描述;GA 仅在"全部接受"后加载;在开发/测试/CI 由环境开关关闭;新增 CSP(仅在启用时放行 Google 域名)。**同意横幅三选一**:**全部接受**(GA + 一方使用事件)/ **仅必要**(无 GA,一方产品事件保留)/ **全部拒绝**(无 GA、无一方使用事件,只保留服务运行必需的记录:额度、作业、日后计费)。若法务认为一方使用事件属"必要",后两项合并。时间:一方事件表尽早(B0/B1),GA4、横幅、CSP、隐私声明在 B4。验证:封装拒绝禁用参数(单元)、未同意时无分析请求(E2E)、清洗后的 URL 不含 ID | **已批准**(用户,2026-10-21) |
| D-85 | **Content path (2026-10-22, see [content-architecture](content-architecture.md))**: parameterized question families plus per-topic content blueprints come first; the question bank and MathText are **deferred** until tutor feedback shows content that families cannot generate. This partly reverses the earlier bank-first preference (D-77 had already said the generator would not become a pure bank). The bank design stays on file; its closed skill vocabulary and verified/reviewed/draft tiers are kept. A bank item and a family output are the same `Question` with provenance `bank:<id>` or `family:<id>` | **Approved** (owner, 2026-10-22)  **Superseded by D-94 to D-101 (2026-10-22): archived as legacy, decoupled from the new flow; see [generation-flow](generation-flow.md).** |
| D-86 | **No mode in the request.** Teaching modes are expressed by document selection; the Prepare form shows two preset cards, "Practice set" (worksheet + solutions) and "Lesson + practice" (all three), that only pre-tick documents. If a purpose is ever needed, add an optional `purpose` with no Zod default. No request field, hash or version change now | **Approved** (owner, 2026-10-22)  Still stands (document presets only); not part of the new flow's critical path. |
| D-87 | **Drop the "Diagnose Weaknesses" mode.** CLAUDE.md excludes automated learner diagnostics and "diagnostic" is a validity claim without evidence. A later "Quick check" part may list each item's target skill (a fact about how it was built); NotePrep never interprets a student's result and the UI never says "diagnostic" | **Approved** (owner, 2026-10-22)  Still stands. |
| D-88 | **Blueprints are repo data selected by an optional `blueprintId` on the dataset mapping row**, carried into the context snapshot (hash-frozen). Missing means `linear.general@1`, which reproduces today's output byte for byte. `sectionInputsParams` adds the blueprint id only when it is not the general one, so old packages and the 27 golden hashes keep their bytes | **Approved** (owner, 2026-10-22)  **Superseded by D-94 to D-101 (2026-10-22): archived as legacy, decoupled from the new flow; see [generation-flow](generation-flow.md).** |
| D-89 | **Practice pacing**: for new blueprint versions, when Tutor Lesson Notes are not selected their minutes go to exercises, using per-family pace, capped at 16 exercises (inside the existing 20 and 60-block caps). `linear.general@1` keeps `planOutline` | **Approved** (owner, 2026-10-22)  **Superseded by D-94 to D-101 (2026-10-22): archived as legacy, decoupled from the new flow; see [generation-flow](generation-flow.md).** |
| D-90 | **Equations with the unknown on the right** use a new verified `swap_sides` operation; `final_form` stays strict | **Approved** (owner, 2026-10-22)  **Superseded by D-94 to D-101 (2026-10-22): archived as legacy, decoupled from the new flow; see [generation-flow](generation-flow.md).** |
| D-91 | **Worksheet parts** (for example Get started, Core practice, Stretch) are emitted first as `paragraph` blocks before each part; a real `heading` block with its schema, renderer and `TEMPLATE_VERSION` bump waits for tutor demand. Must first verify that adjustment numbering and insertion handle paragraphs between questions | **Approved** (owner, 2026-10-22)  **Superseded by D-94 to D-101 (2026-10-22): archived as legacy, decoupled from the new flow; see [generation-flow](generation-flow.md).** |
| D-92 | **Difficulty stays the three-value enum** (basic, mixed, challenge). Question families carry descriptive features and a rung (1 to 3); a preset is which families go in which part. A multidimensional difficulty model is revisited after tutor feedback | **Approved** (owner, 2026-10-22)  Still stands. |
| D-93 | **Independent math-tutor reviewer** who signs off each blueprint version (checklist in content-architecture section F). The owner must name this person before the first blueprint is released to tutors | **Open** (owner to name)  **Re-scoped (2026-10-22):** no longer a blueprint sign-off; a reviewer for spot-checking stored items may be named later. |
| D-94 | **Preview first, export charges (see [generation-flow](generation-flow.md))**: selection first; a web-only preview (no LaTeX compile, no allowance charge); when unsatisfied the tutor types a free-text request and the preview regenerates (still no charge); Export compiles LaTeX and **consumes 1 generation only when the compile succeeds** and the PDFs are available (download not required); a failed compile charges nothing | **Approved** (owner, 2026-10-22) |
| D-95 | **Correctness is a label, not a gate**: LLM-first item generation; cheap checks where they exist (existing linear solver, optional cross-check pass); each item shows its status (checked by code, cross-checked, AI-generated not checked) on screen and in the PDF; export is never blocked; tutors can flag an item, which quarantines it. Needs CLAUDE.md sections 1, 5, 7 and 11 amended (pending owner approval, listed in generation-flow section 8) | **Approved** (owner, 2026-10-22); CLAUDE.md edits **pending** |
| D-96 | **Safe rendering stays mandatory**: MathText (restricted LaTeX-style syntax parsed by our own code) is required again; preview HTML and PDF render from the same parsed content; no raw LLM text reaches LaTeX or HTML; the TeX string is dry-run and safety-checked at preview time so the export compile is expected to succeed. Reverses the deferral in D-85 | **Approved** (owner, 2026-10-22) |
| D-97 | **Export confirmation**: clicking Export opens a dialog ("uses 1 of N generations, check your preview first") with a per-browser "Don't show again today" option the server never relies on; the existing idempotency key prevents double charges. **Open:** whether re-exporting the same draft is free (proposed yes; a content change is a new draft and costs again) | **Approved** (owner); re-export rule **open** |
| D-98 | **LLM spend limits**: lifetime cap of **$25 per test account** (owner). **Proposed, pending owner confirmation and a measured cost per preview:** daily sub-cap about $3, per-preview cap about $0.15, about 10 LLM calls per account per hour, global monthly cap (suggested $100) with an alert at 70 percent and an automatic stop at 100 percent | **$25 approved** (owner, 2026-10-22); the rest **open** |
| D-99 | **Bank cache**: items are collected from day one; stored items are **not served until a bucket reaches a threshold N** (owner example 10,000 rows), then previews randomly draw suitable stored items; N and the switch are configuration. **Proposed, pending:** count per bucket (topic by level), an optional fresh fraction after the switch, and the eligibility rule (selection-only previews, exported, not reported; reported items removed; free-text-derived items never enter the shared bank) | **Mechanism approved** (owner, 2026-10-22); eligibility and per-bucket counting **open** |
| D-100 | **Legacy**: question families, blueprints and the M0 extraction stay in the repo, decoupled from the new flow, and are archived as legacy in the docs; the linear solver and checker may remain as the optional "checked by code" label source. The question bank design is revived only as the cache (D-99) | **Approved** (owner, 2026-10-22) |
| D-101 | **Build order**: slice A preview/export split with today's generator (no LLM); slice B OpenAI adapter, MathText, item statuses, flagging, bank collection with the threshold switch, spend caps; slice C free-text refinement with injection handling and privacy wording. Each slice needs its own go | **Proposed** (owner to confirm) |

**已推迟的限制(诚实清单,均为 UNVERIFIED 或未做)**:
- 没有 gVisor;沙箱与 worker 共享宿主内核。
- worker 被攻破 = 暴露全部 worker 秘密;runner 账户没有出站防火墙;没有镜像签名/来源证明;没有告警系统。
- 2026-10-20 起**已验证**:托管 Actions 上的 `images.yml` 发布工作流(run 39384267711 在 `7c207fa` 上成功,推送三个镜像并输出摘要;**Step Summary 本身没有核对**)、`hosttest` 以 uid 10001 在真实主机上的行为(41/41,含 socket 组映射,见 D-57)。
- 以下**仍未验证**:cgroup v1 主机、`docker save | docker load` 后按摘要引用 LaTeX 镜像是否可解析(staging 用了做法 B:公开镜像,直接拉取)、生成进行中的优雅停止、对真实 staging 站点的冒烟、runner 的 rootless 网络出站。

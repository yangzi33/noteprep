# 决策记录

> 只记录对实现有约束力的内容。相关:[product](product.md) · [architecture](architecture.md) · [implementation-plan](implementation-plan.md) · [security-and-privacy](security-and-privacy.md)

## 1. 已确定的约束(来源:CLAUDE.md,不在此重新讨论)

终身合计 3 次免费完整生成;失败不扣次数;事务内预留/入队/幂等;预留单向迁移 `reserved → consumed|released`;围栏 token;Postgres 持久任务表(不引入 Redis/Kafka/K8s);独立 worker + 每任务隔离沙箱;Web 不运行 TeX;Prisma 直连需服务端 owner 过滤;Stripe 权益只经验签 webhook + 服务端对账授予;数学验证不得使用 eval/CAS/浮点;仅 Math、仅一元一次方程起步;Worksheet(原"学生版")不含独立练习答案;历史成果在订阅过期后仍可访问;不自动开通付费资源/部署。

## 2. 可逆默认选择(已作出,标为假设)

| ID | 选择 | 理由 | 反转条件 / 成本 |
|---|---|---|---|
| D-01 | 英文界面与课件,A4 | 需要一个具体默认;CLAUDE.md 要求不由对话语言推断市场 | 确定目标市场后改模板/文案;模板已版本化 |
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
| D-17 | 目标课程/市场、课件语言、纸张(目标课程:见 §7 D-30) | 英文/A4(D-01),不声称对齐任何考试局 | 上线文案与模板 |
| D-18 | 数据地区、保留期、隐私政策与服务条款、子处理方清单 | 无推荐 | 上线 |
| D-19 | 速率/并发/成本阈值、`maxAttempts`、修复次数 | 先用保守配置值;以真实成本数据确定 | 上线 |
| D-20 | Worker 主机提供商与规格、备份套餐/PITR | 待实测编译耗时与 gVisor 兼容性后选择 | Phase 2 spike 之后 |
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
| D-30 | MVP 的目标课程是 **Ontario Grade 9 数学**;**真实课程数据集是之后的独立里程碑(CM)**,不阻塞其余基础设施。此前只允许**明确标注的示例数据集**(仅开发/staging,界面标注"示例,非真实课程",**不得产生对齐声明**) | **已批准**(2026-10-19) |
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


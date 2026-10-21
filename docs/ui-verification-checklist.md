# UI 里程碑验证清单(给有 Docker 的人)

本清单面向在**有 Docker 的机器**上接手验证的人。开发 U1–U4 的环境(WSL2)**没有 Docker**,因此到目前为止,**没有任何 UI 里程碑的 E2E 或集成测试被实际运行过**;下文每一项"改过/新增但未运行"的测试,其结论都只来自阅读源码、类型检查和单元测试。合并前请先完成本清单。

范围:`feat/ui-foundation`(U1)、`feat/ui-prepare`(U2)、`feat/ui-jobs`(U3)、`feat/ui-lesson`(U4)。背景见 [figma-ui-implementation 计划](superpowers/plans/2026-10-20-figma-ui-implementation.md) 与决定 D-58..D-64([decisions](decisions.md))。

## 1. 已建成的内容(以分支提交为准)

| 里程碑 | 分支 | 内容 | 计划 |
|---|---|---|---|
| U1 基础 | `feat/ui-foundation` | Figma 设计 token、Inter 与 Lora 字体、共享组件(Button/Badge/Notice/Card/SelectField/CheckboxRow/TextAction)、应用外壳(顶栏 + 工作区导航) | [ui-foundation](superpowers/plans/2026-10-20-ui-foundation.md) |
| U2 准备页 | `feat/ui-prepare` | `/prepare` 单页下拉级联表单(课程体系/级别/课程/单元/主题)、PackageOption 复选卡片、StepIndicator、选择摘要、Generate 按钮的挂起保护 | [ui-prepare](superpowers/plans/2026-10-20-ui-prepare.md) |
| U3 作业页 | `feat/ui-jobs` | `/jobs/[id]` 生成进度卡片与步骤列表(失败/取消不显示步骤列表)、仅供读屏的 live 行、`prefers-reduced-motion` | [ui-jobs](superpowers/plans/2026-10-20-ui-jobs.md) |
| U4 课包页 | `feat/ui-lesson` | `/lessons/[id]` 的编译 PDF 视图 + HTML 草稿预览(`?view=draft`,D-60)、KaTeX 0.19.0(本地打包 CSS/字体)、只读 DAL 方法 `getLessonPackage` | [ui-lesson](superpowers/plans/2026-10-20-ui-lesson.md) |

进行中(**不在上述分支上,本清单不涉及其验证**):U5(仪表盘与 My materials,`feat/ui-dashboard`)、U7(落地页,`feat/ui-landing`)。U6(预设调整与文字更正)阻塞于 M6 后端,尚未开始。

## 2. 命令顺序(运行所有尚未运行的测试)

以下脚本名均已对照 `package.json` 核实。前提:Node 24.13.1、pnpm 10.33.0、Docker 可用。**建议(未验证)先停掉自己的 `pnpm worker:dev`**:E2E 与它共用同一个数据库,会互相抢作业。

```bash
# 0. 在 feat/ui-lesson(栈顶)上;它包含 U1–U4 的全部提交
pnpm install --frozen-lockfile

# 1. 已在 WSL 里跑过的静态检查与单元测试(复核即可)
pnpm lint
pnpm typecheck
pnpm test            # U4 修复轮报告记录 39 个文件 / 861 个测试通过(未在本文档提交中重跑)
pnpm build           # 应产出 katex 的 CSS chunk 与 woff2 字体(见 §4 检查项)

# 2. 集成测试(真实 Postgres)——U4 的 ownership 与 getLessonPackage 用例在此
pnpm db:up
cp .env.example .env     # 如果还没有 .env
pnpm test:integration

# 3. Supabase 本地栈,然后 E2E
pnpm supabase:start
pnpm supabase:status     # 把 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY 等写入 .env
pnpm db:migrate:deploy
pnpm db:dev-roles
pnpm test:supabase       # 不是本次改动的目标,但 E2E 依赖同一栈,先确认栈本身健康
pnpm exec playwright install chromium
pnpm test:e2e            # 构建并启动应用(3100 端口),测试内启动真实 worker

# 4. 可选:用真实 PDF 跑 E2E(需要 LaTeX 镜像)
pnpm latex:image
E2E_COMPILER=docker pnpm test:e2e

# 5. 收尾
pnpm supabase:stop
pnpm db:down
```

说明:
- 建议(未验证):每个 U 分支自己的提交都可以单独检出验证;如果 E2E 失败,先在失败测试所属的最早分支上复现,再向上叠加,这样能定位到是哪个里程碑引入的。
- `pnpm test:latex` 与本次 UI 改动无关(未触碰 worker/渲染),无需为 U1–U4 单独运行。

## 3. 改过或新增、但**未被执行**的测试

"未运行"的含义:E2E/集成测试需要 Docker,在 WSL 环境里无法启动,所以下表每一行都**没有通过也没有失败的证据**。

| 里程碑 | 文件 | 改了什么 | 它证明什么(通过时) |
|---|---|---|---|
| U1 | `tests/e2e/skeleton-path.spec.ts`(约 108 行) | 选择器 `p[role=alert]` → `main [role=alert]`(Notice 渲染的是 `div`,不再是 `p`) | 额度用尽时第 4 次生成被页面拒绝:该选择器在页面上恰好匹配一个元素,断言含义不变。审阅者只通过阅读核对过 |
| U2 | `tests/e2e/prepare.spec.ts`(整体重写) | 旧的"点链接逐步选择"改为"用下拉框选择";新增对 `selection-fields` 的 `data-hydrated="true"` 等待(第一次 `selectOption` 之前);修复分号和课程文字断言。5 个测试:下拉选择→生成→完成;不可验证主题灰显且改 URL 也选不中;不一致选择被礼貌拒绝;刷新/后退保持选择(URL 即状态);未登录被送去登录 | 级联 `router.push` 在真实浏览器里工作、Next 16.4.2 下挂起语义、URL 为状态、不支持主题的两层拒绝。**每个 pass/fail 判断都只来自阅读** |
| U3 | `tests/e2e/skeleton-path.spec.ts`(未改源码,但依赖的页面标记变了) | 作业页断言(`job-status` 的 `data-state`、`job-state` 文案、"Cancel generation" 按钮、"did not use one of your generations"、"took too long")经阅读核对仍被满足 | 成功/失败/取消/超时四种终态在新进度卡片上仍然正确显示且额度返还文案未丢。**只经阅读追踪,从未执行** |
| U4 | `tests/integration/ownership.test.ts`(51 行) | `lessons` 的 DAL 键集合改为 `["getArtifact", "getLessonPackage", "getLessonView"]` | 新增的 DAL 方法被纳入越权测试范围:没有"未被攻击的方法"悄悄多出来 |
| U4 | `tests/integration/lesson-request-v2.test.ts`(约 742–760 与 793–825 行,已重新 grep 核对) | 新增:所有者正例(`revisionId`、精确键集合、节数 > 0、输出中无 manifest/存储路径;显式 revision id 返回同一修订);攻击用例(他人的课包、他人的修订、所有者用别的课包的修订、所有者用自己另一个课包的修订、未知课包、未知修订、已删除课包、旧占位/legacy 课包、草稿状态修订)均期望 `NotFound` | `getLessonPackage` 对真实流水线产物可用(正例),且在所有越权/错配组合下一律 `NotFound`。**已知缺口**:"同一课包较早的已完成修订"子用例被跳过,因为 `seedRevision` 写死 `schema_version 1`,无法造出第二个课包修订;"draft"用例命中的是 schemaVersion 检查而不是状态过滤(单元测试 `tests/unit/lessons-package-dal.test.ts` 固定了状态过滤) |
| U4 | `tests/e2e/lesson-preview.spec.ts`(约 132 行,新增) | 测试名:"the draft preview shows the same revision as an HTML view, without a PDF frame, and answers only in the solutions"(`?view=draft`、无 `pdf-frame`、下载链接带同一 revisionId、三个标签页链接都带 `view=draft`、Worksheet 不含 "Answer:"、Solutions 含 "Answer:") | D-60:草稿预览与 PDF 同一 revision;答案只出现在答案册。定位器经阅读 `page.tsx`、`lesson-draft.tsx` 核对,**未执行** |

**有风险的既有测试(未修改,但依赖本次 UI 改动,同样未运行)**:

| 里程碑 | 文件 | 风险点 | 通过时证明什么 |
|---|---|---|---|
| U2 | `tests/e2e/lesson-preview.spec.ts`(116–117 行的 `uncheck()`) | 需要点击落在真实 checkbox 上;U2 修复把输入置于 `z-10` 之上,避免被标签覆盖层挡住 | 复选卡片的覆盖层不会挡住 checkbox(`uncheck()` 不超时) |

已经运行过的:`tests/unit/*`(含 `ui-*.test.ts`、`prepare-*.test.ts`、`job-*.test.ts`、`html-view.test.ts`、`math-html.test.ts`、`lesson-draft.test.ts`、`lessons-package-dal.test.ts`)在 `pnpm test` 中通过。注意:`lessons-package-dal.test.ts` 用的是假 DB,不能代替上面的集成测试。

## 4. 手动视觉与可访问性检查(1440px 与 390px)

每项都在**两个宽度**下各看一遍;浏览器开发者工具的设备模拟可用于 390px,但移动端 PDF 查看器需要真机(见 README M5 的未验证说明)。

### 4.1 外壳与导航(所有页面)
- [ ] 顶栏 logo、工作区导航、账号邮箱:1440px 一行显示;390px 下邮箱对读屏器可见但视觉上折叠(`max-sm:sr-only`),顶栏不横向溢出(包括更窄的 320px,已知"可能溢出、未验证")。
- [ ] 长邮箱在 ≥sm 宽度下被截断(`truncate`),而不是撑大顶栏。
- [ ] 导航当前页有 `aria-current`,Tab 顺序合理,焦点环可见。
- [ ] 字体:Inter(正文)与 Lora(logo)实际加载(开发者工具 Network/Computed),构建机上 `next/font` 需要网络。

### 4.2 `/prepare`
- [ ] **仅键盘走一遍**:Tab 到课程体系下拉,用方向键改选,**焦点留在该下拉上**(不被重挂载抢走);继续 Tab 到级别、课程、单元、主题,每次更改后焦点保持。
- [ ] 下拉改变、导航尚在加载时,**Generate 按钮处于禁用状态**(带 `aria-busy`),此时在表单里按 Enter **不会提交**旧主题;加载完成后恢复。可用开发者工具节流网络来放大这个窗口。
- [ ] **复选卡片整张可点击**(Notes/Worksheet/Solutions),点卡片任何位置都切换勾选;键盘空格切换;选中态不只靠颜色(有勾选标志);焦点环可见。
- [ ] 不支持的主题灰显并有原因说明(下拉的短标签旁有提示),无法选中。
- [ ] 刷新、后退保留选择(URL 即状态);选择摘要与所选一致。
- [ ] 关闭 JavaScript 后:级联下拉不工作(已知,见 README),但页面不白屏;已有选择的 URL 打开时提交表单仍能生成(生成 POST 本身不依赖 JS)。
- [ ] 1440px:卡片布局与 Figma 截图对照;390px:单列、无横向滚动、触控目标 ≥44px(`min-h-11`)。
- [ ] 样例数据集横幅在每个分支(含不支持主题分支)都显示(D-30)。

### 4.3 `/jobs/[id]`
- [ ] 排队 → 运行 → 成功各状态:步骤列表(选择/生成/验证/编译/保存)只在**非失败/非取消**时显示;失败与取消只显示结果提示,不显示"未开始"的步骤。
- [ ] **读屏器**(NVDA/VoiceOver)下状态变化被播报:live 行是仅供读屏的元素(`data-testid="job-live"`,无 role)。确认失败时**不会重复朗读两遍**(live 行 + `role=alert` 的提示,已知可能)。
- [ ] **减少动态效果**:系统开启 `prefers-reduced-motion` 后,旋转图标与进度提示图标不再动画(`motion-reduce:animate-none`)。
- [ ] 取消按钮可达、有可见焦点;取消后的焦点位置合理(已知:未专门处理)。
- [ ] 成功后自动跳转到 `/lessons/[id]`;"My materials"/"Create another" 链接触控目标 ≥44px。
- [ ] 失败文案包含"did not use one of your generations",超时文案包含"took too long"。

### 4.4 `/lessons/[id]` — PDF 视图(默认)
- [ ] 三个文档标签页切换,链接都带 `rev`;PDF 在 `<iframe>` 中显示;"新标签页打开"与"下载 PDF"可用;页数文字仅在 PDF 视图出现。
- [ ] 视图切换(PDF / Draft preview)的 `aria-current="true"` 与当前视图一致;文档标签页的 `aria-current` 与当前文档一致(不要出现两个同类 current 竞争)。
- [ ] 提示"AI 材料请先自己通读"与课程信息面板可见;样例数据集写"不是真实课程,不作对齐声明"。
- [ ] 390px:布局不横向溢出;PDF 嵌入在手机上可能不显示(降级链接可用)。

### 4.5 `/lessons/[id]?view=draft` — HTML 草稿
- [ ] 顶部有"Draft preview. The exported PDF is the final version."提示;没有 `pdf-frame`;下载链接仍指向同一 revision 的文件。
- [ ] **KaTeX 渲染**:方程、分步解答、答案行(`Answer:`)正确渲染;**无无样式的原始 TeX、无缺字**(确认 KaTeX 字体来自本机打包的 woff2,开发者工具 Network 里没有对外域名的字体请求)。
- [ ] **窄屏溢出**:390px 下较长的展示公式在自己的容器内横向滚动(`overflow-x-auto`),整页不出现横向滚动条;纸张内边距在窄屏更小(`p-4 sm:p-8`)。
- [ ] Worksheet 草稿**不含** "Answer:";Solutions 草稿含 "Answer:"。
- [ ] 草稿与 PDF 的差异在预期内:无页眉行(Name/Date、AI-assisted 行)、计时行的省略号对应 PDF 的 `\hfill`——这些是已记录的有意差异,不是缺陷。
- [ ] 无法用 KaTeX 表达的数学退化为纯代码文本而不是报错。

### 4.6 对比度抽查
- [ ] 主按钮(白字/主色)、禁用按钮、次要文字(`text-text-*` 系列)、徽章与各 Notice 变体(error/success/progress/info)、焦点环,在 1440px 与 390px 下用对比度检查工具(如浏览器开发者工具的对比度提示或 axe)抽查,正文文字 ≥4.5:1,大字与图形元素 ≥3:1。
- [ ] 复选卡片的 `has-[:focus-visible]` 焦点环对比度(已知未检查)。
- [ ] 禁用态的 CheckboxRow 文字颜色(依赖 `cn`/tailwind-merge 解析 `text-foreground` 与 `text-text-disabled`,已知需目检)。

## 5. 已知延期项(摘自各里程碑的 SDD 账本,略有精简)

以下来自 `.superpowers/sdd/*/progress.md`(本地、被 gitignore 的草稿文件)。按里程碑转录并略有精简,**不代表已决定要修**。

### U1 基础
- `.dark` 块缺少新增的 9 个变量(暗色模式未使用,计划是保持 `.dark` 不动);ui-tokens 测试是精确字符串比较,没有测试字体接线(构建覆盖)。
- 非默认 Button 变体丢失了禁用外观(只有默认变体有禁用颜色),目前没有调用方禁用它们(M2)。
- `cn`(tailwind-merge)不会合并自定义的 `rounded-*` token:Button xs/icon-xs/icon-sm、Card 的 className 覆盖(M3)。
- 可能存在 320px 顶栏溢出,未验证(M4)。死代码(M6)与其他杂项:info 类 Notice 看起来像 success、`next/font` 在构建时需要网络(M7)。
- Notice 测试里有 `as never` 强转;outline 变体去掉了 `dark:` 样式(仅浅色应用)。
- CheckboxRow 禁用文字颜色依赖 `cn` 的解析;ui-controls 测试假设 `next/link` 渲染为普通 `<a>`;原生 checkbox 的焦点环较小。
- layout.tsx 与 app-header.tsx 重复的 header/logo 链接 class;头像首字母 `charAt(0)` 对 emoji 邮箱不对;WorkspaceNav 的 `aria-current` 与登录/未登录渲染没有组件级测试。
- review-reminder 现在带 `role="note"`(无害);Notice 内的 Link 位于 flex 列的内层 div(仅视觉)。
- **未决风险**:E2E 未运行;布局与移动端视觉从未在浏览器里看过。

### U2 准备页
- 级联下拉在 JS 之前不工作(已知限制,生成 POST 不需要 JS);无 noscript 回退(M-1b)。
- 较旧的已发布版本在 URL 中时,`v` 下拉显示占位符(M-2,仅手改 URL);改单元时丢失包选择(M-3);主题提示未用 `aria-describedby` 关联(M-4);布局偏移(M-5);回退页缓存的幂等键(M-9);README 里"向导"措辞待更新。
- `changeSelection` 留下显式 `undefined` 键(无害);无级别数据集的陈旧 `params.level` 保留;无级别测试没断言禁用标志。
- SelectionFields 按硬编码 key 拆分字段(其余被丢弃);`onChange` 接线(`router.push` + `selectionHref`)没有单元测试覆盖,只能靠 E2E;布局断言只是 class 字符串检查。
- 禁用的 PackageOption 标签仍显示 `cursor-pointer`;StepIndicator 的 `key={label}` 在重复标签时冲突;勾选标志与 `has-[:checked]`/`peer-checked` 样式没有回归测试(需浏览器);卡片是普通 div 不是 Card。
- 每次渲染约 7 次顺序 `loadTree` 调用(以后加一个 DAL 读方法);课程下拉在选课程前只显示名称(旧列表写"· sample data");级别字段在选 `v` 之后才出现(布局偏移);`?v` 已设但零课程时页面显示 no-curricula 而不是 bad-selection。
- E2E:第一次 `selectOption` 依赖 React 水合(retries:0 下可能 flaky);课程标签不再断言;主题顺序依赖 `loadTree` 序号排序;label 覆盖层与 `uncheck()` 未验证;Task 5 隐含的"实现者跳过了红灯运行,审阅者靠阅读核对"。
- 修复波之后的延期:挂起导航期间下游 select 保持旧选项(重建的 href 用了旧参数,最终状态一致);重同步/回退逻辑与 provider 挂起接线没有单元测试;`z-10` 测试只检查 class 名;禁用按钮上的 `aria-busy` 没有可见原因。
- **未决风险(需要人跑 E2E/浏览器)**:焦点保持、Enter 键阻断、`uncheck()` 对标签覆盖层、Next 16.4.2 中 `router.push` 的挂起语义、1440/390 布局、重写的 `prepare.spec.ts`、级联导航。

### U3 作业页
- 旧的第 1 步措辞(M3);没有时间预期,401/404 被显示成"仍在尝试"(M5);取消后的焦点(M6);`stageLabel`/`STAGE_LABELS` 死代码(只有单元测试使用);`jobSteps` 里 failed/canceled-with-stage 分支在当前后端下不可达(后端在失败/取消/完成时总是把 stage 重置为 NULL)。
- 单元测试缺 failed+validating、canceled+validating、failed+storing、canceled+compiling、queued 带非空 stage;未知运行时 stage 只会让第 1 步完成(类型联合已排除)。
- data-state 测试的正则依赖属性顺序;没有测试证明表单 action 就是 cancelAction(静态标记渲染占位符);空 `panel.text` 会渲染空段落(既有契约)。
- 失败文字可能被读屏器读两遍(live 行 + `role=alert` Notice);不变量循环仍用不可达的 failed+stage 情形(无害);`<ol>` 门控后缩进错位;Notice progress 的 motion-reduce class 未测试。
- 提交 trailer 写的是 Claude Haiku 5.5(实现者是 Haiku 智能体,历史未重写)。
- **未决风险**:skeleton-path 的作业页断言只经阅读追踪、从未执行;读屏器对 live 行的行为未验证。

### U4 课包页
- 草稿标题仍是 `<p>` 而非标题元素;格式错误但合法的内容会 500;计时行用省略号而 PDF 用 `\hfill`;页眉行(Name/Date、AI-assisted)有意缺失;草稿视图的额外 DB 工作;依赖安全公告(advisory)未检查;KaTeX 运行时字体未检查。
- `splitInlineMath` 不处理 `\$`(生产者从不输出);`strict:error` 会拒绝非拉丁字符(回退到文本)。
- `getLessonPackage`:"draft"集成用例命中的是 schemaVersion 检查而非状态过滤;非 UUID id 会到达 Prisma(页面必须用 zod 校验 `rev`/`view`);包内含答案与原始请求/上下文——**绝不能把整个包传给 Client Component 或序列化进 props**(只传派生的 HTML 视图树给服务端组件)。
- `DIFFICULTY_LABEL` 重复(有防漂移测试);hostile 测试用的是每种块的第一个。
- Task 5(页面)没有单独的任务审阅,由最终整分支审阅覆盖。
- 草稿 E2E 缺少:notes 草稿里的 "Answer:" 检查,以及非草稿视图下没有 `draft-notice` 的检查。
- `getLessonPackage` 没有针对 schema 不匹配/无效内容的 NotFound 路径的集成测试。
- `view-tabs` 没有可访问性断言。
- `pnpm lint` 会扫描 `.claude/worktrees/**`;worktree 清理后需要加 eslint ignore 与 `.gitignore` 条目。
- **未决风险**:KaTeX CSS/字体打包与路由使用已在构建中看到产出(一个 CSS chunk、20 个 woff2),但从未在浏览器里确认;`ownership.test.ts` 与 `lesson-request-v2.test.ts` 未运行;新的草稿 E2E 未运行。

### U5 仪表盘(进行中的分支 `feat/ui-dashboard`,审阅发现,均为"修复中,见 feat/ui-dashboard")
- 各卡片的仪表盘链接名称相同(修复中,见 feat/ui-dashboard)。
- "Recent documents" 措辞,正改名为 "Recent activity"(修复中,见 feat/ui-dashboard)。
- 缺少 failed/canceled 且带 revisionId 的卡片测试用例(修复中,见 feat/ui-dashboard)。
- 缺少已有数据的仪表盘 E2E(修复中,见 feat/ui-dashboard)。

## 6. 合并顺序

栈式分支,按顺序合并(每一步合并后在合并结果上跑完整本地检查,CLAUDE.md §2):

1. `feat/ui-foundation`(U1;基于 `docs/figma-ui-plan`,该分支的文档提交 D-58..D-64 与 CLAUDE.md §7 的一句修订随之进入;已确认它是 `feat/ui-foundation` 的祖先)
2. `feat/ui-prepare`(U2)
3. `feat/ui-jobs`(U3)
4. `feat/ui-lesson`(U4)
5. 然后是并行分支(各自基于哪个分支以其计划为准,**合并前需重新核对冲突**):`feat/ui-dashboard`(U5,进行中)、`feat/ui-landing`(U7,进行中)。U5 若新增 DAL 只读方法,还需要 `pnpm test:integration`。

CLAUDE.md §7 的一句修订(预览双轨,D-60)在提交 `5090dca` 中,该提交属于 `docs/figma-ui-plan`,经 `feat/ui-foundation` 的祖先链进入;合并时请确认它随栈一起进入 main。

# Figma UI/UX 落地实施计划(提案,待评审)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已定稿的 Figma 设计(文件 `PurgKHaONJxdKzjIoeuPoi`,NotePrep)以增量方式落到现有 Next.js 前端上,不改动生成 API、文档渲染和 PDF 导出的行为。

**Architecture:** 保持现有"服务端渲染 + URL 驱动 + DAL"结构。先建立设计令牌与一个应用外壳(顶栏 + 侧栏 + 移动端导航),再逐页换皮(`/prepare`、`/jobs/[id]`、`/lessons/[id]`、`/lessons`),最后做落地页。Figma 中后端尚不支持的交互**不做成假控件**:要么延后(依赖 M6),要么等你决定后再做。

**Tech Stack:** Next.js 16 App Router、React 19、Tailwind CSS 4(`@theme inline`)、shadcn/ui(radix-nova,现仅 `button`)、lucide-react、Vitest、Playwright。

**Spec:** Figma 文件(14 个画板,见 §1);产品约束见 `CLAUDE.md` §1、§7、§9、`docs/refactor-plan.md` §4–§6、`docs/decisions.md` D-30/D-31/D-33。本计划**只做分析与规划,尚未写任何代码**。

## Global Constraints

- NotePrep 是面向导师的 SaaS,不是学生学习平台;表单优先;LaTeX 只在后台,界面不出现 LaTeX、`.tex`、编译日志(D-31)。
- 预览必须是真实编译的 PDF;不得用 HTML/KaTeX 渲染题目或答案来代替(CLAUDE.md §7)。
- 数学内容(题目、答案、步骤)不可手改,只能确定性重新生成;手动更正只限文字字段。
- 课程名称、编码、对齐声明只来自数据集;Figma 中的 "Ontario · Grade 12 · MCV4U" 只是示意文案,不得硬编码。
- 不改后端逻辑(DAL 写路径、作业、额度、渲染、导出);确需的**只读** DAL 扩展必须单独说明理由并附测试。
- 授权在服务端的每个 Server Action / Route Handler 里验证;UI 隐藏不算授权。
- 项目文档用中文,代码标识符与注释用英文;Git:每个里程碑一个 `feat/ui-*` 分支,小步提交,只按明确路径 `git add`,**不直接推 `main`**。
- 不删除、不放宽现有测试;现有 `data-testid` 钩子必须保留(见 §6)。

## Review Focus

- Figma 的"编辑器"整体假设了今天不存在的能力(逐题编辑/重新生成/删除/新增、修订对比、撤销)→ U6 只做规格,等 M6 后端;不在此前交付空壳控件。
- Figma 的预览是 HTML 模拟页(含图形);必须改回 PDF `<iframe>`,缩放控件无法接管 PDF 查看器 → U4 保留 `pdf-frame`。
- Figma 中完全没有剩余额度、订阅/账单、示例数据横幅、对齐信息面板、登录页 → 这些是产品必需项,需要补设计(见 §5),不能因为"设计里没有"而删掉。
- 定价区(3 档、£、"每月 5 次"、Studio 多人)与 CLAUDE.md 冲突(终身 3 次免费、单一月度计划、不含团队)→ U7 默认不上线该区。
- 移动端 390px:侧栏变为 60px 顶部导航,表单 select 触控高度 ≥ 44px → 每个里程碑用 390px 与 1440px 截图核对。

---

## 0. 已批准的决定(2026-10-20,见 `docs/decisions.md` D-58–D-64)

Figma 只是视觉占位稿,功能以产品约束和代码为准。**这些决定取代下文 §5 中 A 类的"建议"列**(§5 保留作为分析记录):

| 决定 | 结论 | 对本计划的影响 |
|---|---|---|
| D-58 | 设计是占位,不影响功能 | 示例数据、头像、缩略图等不当作需求 |
| D-59 | 材料类型 = 现有三份文档(多选),无 Quiz | U2 做三份文档的多选卡片 |
| D-60 | **预览双轨**:应用内 HTML 实时预览 + 编译 PDF 为权威导出;**已改 CLAUDE.md §7 的一句** | U4 新增 HTML 预览;U6 的编辑反馈用它;新增 KaTeX 依赖 |
| D-61 | 题目编辑要做,但数学只能确定性重新生成,文字字段可手改 | U6 范围确定;仍依赖 M6 后端 |
| D-62 | 定价按原模型:3 次终身免费 + 一个月度订阅,配置化并标 `TEST VALUE` | U7 做单一计划卡片,不做三档/Studio |
| D-63 | 课程可配置,全部来自数据集 | U2/U5 不硬编码任何课程文案 |
| D-64 | 营销文案可提 LaTeX;界面仍不暴露 `.tex`/不让用户写 LaTeX | U7 不需要去掉该字样 |

**我对 D-61 的解释(请确认)**:题目、答案、步骤不允许手写修改(否则答案会与题目不一致,违反 §7);"编辑题目"通过 Regenerate / Add / Remove / 单题难度 / 换一个同类题 + 文字字段更正来实现。如果你的意思是允许直接手改题目里的数字或式子,请告诉我——那需要新的验证与重算机制,是更大的范围。

**仍待你回答的事项**:缺口 C(额度显示、示例数据横幅、登录/账户页、排队重试状态)——默认由我按设计系统拟定,你在评审实现时验收;B4/B5(搜索筛选、重命名/复制/删除)和 B7(缩略图、模板、默认设置)、B8(署名)——默认**不做**,除非你要加。

## 1. Figma 概览(已读取)

文件只有一页 `Page 1`,共 14 个顶层画板:

| 画板 | 节点 | 尺寸 |
|---|---|---|
| Visual design system | `35:812` | 1200×7407 |
| Application components | `49:15874` | 1504×4182 |
| Desktop landing page | `35:3` | 1440×7870 |
| Mobile landing page | `35:411` | 390×11187 |
| Dashboard · Desktop / Mobile | `49:12732` / `49:12908` | 1440×1447 / 390×2881 |
| Material creation · Desktop / Mobile | `49:13060` / `49:13236` | 1440×1634 / 390×2033 |
| Document editor · Desktop / Mobile | `49:13389` / `49:13603` | 1440×2263 / 390×3387 |
| My materials · Desktop / Mobile | `49:13799` / `49:14107` | 1440×1751 / 390×2606 |
| Supporting states · Desktop / Mobile | `49:14287` / `49:14477` | 1440×5767 / 390×11225 |

已核对:全部桌面画板截图、设计系统变量、组件画板的结构、补充状态的结构与 5 个关键状态截图。**未逐一查看**:移动端画板的像素细节(只确认了结构/尺寸)、落地页中间几节的文案细节。实现每个里程碑时,按 figma-design-to-code 流程对该画板调用 `get_design_context` 取高保真代码和资源,并以截图为目标。

## 2. 现有前端现状

- **路由**:`/`(占位首页,文案还是 "Phase 1 skeleton")、`/login`、`/account`、`/prepare`(URL 驱动的逐级选择:课程 → 级别 → 课程 → 单元 → 主题 → 选项)、`/lessons/new`(旧快速表单,M7 退役)、`/jobs/[id]`(状态 + 2 秒轮询 + 取消)、`/lessons/[id]`(文档标签 + PDF iframe + 对齐面板)、`/lessons`(历史 + 额度)、`/lessons/[id]/documents/[doc]`(签名 URL 路由)、`/api/jobs/[id]`。
- **样式**:Tailwind 4,`globals.css` 是 shadcn 默认的灰度 oklch 令牌;**没有加载任何字体**(系统 sans);页面里是内联工具类(`rounded border p-3`),没有共享组件;只有 `components/ui/button.tsx`(shadcn)、`site-nav.tsx`、`job-status.tsx`。有 `.dark` 变量块,Figma 没有深色设计。
- **视图模型**:`lib/ui/{job-view,lesson-view,messages,prepare-url}.ts` 是纯函数,已有单元测试——**保留并复用**。
- **架构护栏**:ESLint 禁止在 DAL 之外用 Prisma、在 env 模块之外读 `process.env`(`tests/unit/lint-boundaries.test.ts`);`proxy.ts` 刷新会话。
- **后端能力(与设计相关)**:`createGeneration`、`getJob`、`getLessonView`(三份 PDF 清单 + 对齐信息)、`history.getAllowance`、`history.listJobs`(只有 jobId/title/state/stage/时间)。**没有**:调整/更正(M6 未开始)、课包重命名/复制/删除、搜索/筛选/排序、缩略图、用户默认设置、显示名称(`Profile` 只有 id/status/stripeCustomerId)、订阅(Phase 3)。

## 3. 设计令牌规格

Figma 变量(`get_variable_defs`,节点 `35:812`)→ 项目 CSS 变量。**原则**:沿用 shadcn 的语义变量名(`--background`、`--primary` 等,使现有 `button.tsx` 与未来 shadcn 组件自动继承),Figma 独有的角色用新增变量。只改 `:root`;`.dark` 块不动,不测试(Figma 无深色稿)。

### 3.1 颜色

| Figma 变量 | 值 | 映射到 |
|---|---|---|
| surface/canvas | `#f8f7f3` | `--background` |
| surface/default | `#ffffff` | `--card`、`--popover`、`--surface`(新增,标题栏/输入框底) |
| surface/workspace | `#f0f1ec` | `--secondary`、`--muted`、`--sidebar` |
| surface/accent | `#e9f0eb` | `--accent`(选中项、提示条、徽章底) |
| surface/inverse | `#202c29` | `--surface-inverse`(新增) |
| surface/danger | `#fbf0ed` | `--danger-surface`(新增) |
| text/primary | `#202c29` | `--foreground`、`--card-foreground` |
| text/secondary | `#626d67` | `--muted-foreground` |
| text/accent | `#245f50` | `--accent-foreground`、`--text-accent`(新增) |
| text/on-action | `#ffffff` | `--primary-foreground` |
| text/on-dark-muted | `#dce4dd` | `--on-dark-muted`(新增) |
| text/danger | `#a53c34` | `--destructive` |
| text/disabled | `#57635c` | `--text-disabled`(新增) |
| action/primary | `#245f50` | `--primary` |
| action/hover | `#194839` | `--primary-hover`(新增) |
| action/disabled | `#e2e5df` | `--action-disabled`(新增) |
| border/default | `#d9ded7` | `--border` |
| border/control | `#7d8c83` | `--input`(控件边框,比默认边框深) |
| border/focus | `#245f50` | `--ring` |
| border/danger | `#a53c34` | `--border-danger`(新增) |
| document/ink | `#141414` | 不进应用(只用于设计稿里的纸面模拟;PDF 由后端渲染) |

在 `@theme inline` 中补 `--color-surface-inverse` 等映射,使 `bg-surface-inverse` 等类可用。

### 3.2 圆角、间距、尺寸

- 圆角:tag 4、control 6、notice 8、card 12 → 新增 `--radius-tag/-control/-notice/-card`(px),**不**改动现有由 `--radius` 推导的 `--radius-sm…4xl`(避免波及 `button.tsx`)。`button.tsx` 的 `rounded-lg`(≈10px)与 control 6px 不一致,在 U1 里调整 button 变体而不是改全局半径。
- 间距:0/2/4/6/8/10/12/16/18/20/24/28/36/48/64 → Tailwind 默认 4px 刻度已覆盖(0.5/1/1.5/2/2.5/3/4/(4.5)/5/6/7/9/12/16);`18` 用 `[18px]` 任意值,不新增令牌。
- 触控:`control/min-touch` 44 → 所有可点击控件 `min-h-11`。

### 3.3 字体

- **Inter**(界面):Regular 400 / Medium 500 / Semi Bold 600;字号 10、11、12、13、14、16;行高 1.5/1.6/1.65(正文)与 1.0(按钮/标签);大写小标签字距 1.4–1.8px(10/11 Semi Bold)。
- **Lora Regular**(标题):页面标题 34px/行高 1.2(其他标题字号在实现时从各画板 `get_design_context` 读取——**Figma 变量里没有标题的文字样式**,这是设计稿的缺口,需要确认)。
- **STIX Two Text**(9/10px):只用于设计稿里的纸面模拟,**应用不加载**(PDF 里的字体由后端模板决定)。
- 加载方式:`next/font/google`(Inter、Lora),在 `layout.tsx` 设置 CSS 变量并映射到 `--font-sans`、`--font-heading`(`globals.css` 里已有 `--font-heading` 占位)。**风险**:构建期需访问 Google Fonts;CI/受限网络下失败 → 备选 `next/font/local` 自托管(需确认字体许可证并提交字体文件)。

### 3.4 状态与可访问性(来自 "Control states and accessibility" 与组件画板)

输入/按钮有 Default/Focus/Invalid/Disabled;焦点环用 `--ring` 2px;错误同时用颜色 + 文本 + `aria-invalid`;进度/成功/错误提示条用 `role="status"`/`role="alert"`。实现 `Notice`(intent=error/success/progress)时沿用这些语义,**不能只靠颜色**。

## 4. 设计 → 代码组件映射

"复用"= 已有且可直接用;"改"= 已有但要改;"新建"= 不存在。共享组件放 `src/components/ui/`(原子)与 `src/components/app/`(应用级,新建),保持现有 shadcn 约定;**不做空抽象**,只建被至少两个画板使用的组件。

### 4.1 共享组件(Figma `Application components` 画板)

| Figma 组件 | 现有代码 | 处置 |
|---|---|---|
| Controls / PrimaryButton(Default/Focus/Disabled,Fluid) | `ui/button.tsx` variant `default` | **改**:调整颜色/圆角 6/高 48/字重 600,加 `fluid` 用法(`w-full`)。不改 API |
| Controls / SecondaryButton | button `outline` | **改**:边框用 `--input` |
| Controls / TextAction(Edit document、Rename、Use template →…) | `<Link className="underline">` | **新建** `TextAction`(链接/按钮两用,最小 44px 点击区,带图标) |
| Controls / SelectField(Default/Focus/Invalid) | 内联 `<select className={inputClass}>` | **新建** `SelectField`(原生 `<select>` + label + 提示/错误,不引入 Radix Select,保持服务端渲染与无 JS 可用) |
| Controls / CheckboxRow、RadioIndicator | 原生 checkbox | **新建** `CheckboxRow`(原生 input,样式化);`RadioIndicator` 仅在 U6 用 |
| Feedback / Badge(Worksheet、YOUR WORKSHEET、✓ All changes saved) | 无 | **新建** `Badge` |
| Feedback / InlineNotice(Error/Success/Progress) | 内联 `<p role=alert className="rounded border …">` | **新建** `Notice`,替换现有各处内联提示(`sample-banner`、`bad-selection`、`review-reminder` 等的 testid 保留) |
| Shell / AppHeader(Desktop 80px / Mobile 72px) | `site-nav.tsx` | **改** → `AppHeader`:品牌标记 + "Your tutor workspace" + 头像/名称 |
| Shell / Navigation(Dashboard / Create material / My materials) | `site-nav.tsx` 顶部链接 | **新建** `WorkspaceNav`:桌面 208px 侧栏,移动端 60px 顶部条;`aria-current` |
| Editor / QuestionListItem | 无 | 延后到 U6 |
| NotePrep logo / Notebook mark | 文本 "noteprep" | **新建** `Logo`(SVG 从 Figma 下载到仓库,不引用临时 URL) |
| 卡片/分区容器("surface recipes") | 内联 `rounded border` | **新建** `Card`(白底、`--border`、12px 圆角)——仅当 ≥2 处使用时抽取 |

### 4.2 页面映射(Figma 画板 → 现有路由)

| Figma 画板 | 路由 | 现状 | 差异 / 处置 |
|---|---|---|---|
| Dashboard | **新增 `/dashboard`**;登录后 `/` 重定向到它 | `/` 是占位页 | 新页面。数据只能来自 `history.listJobs`;缩略图/"稍后再看"/模板/默认设置**无后端**(见 §5)→ U5 只做问候、"Create material" 主操作、最近文档(无缩略图)、额度 |
| Material creation | `/prepare` | 逐级链接式选择 + 主题摘要 + 选项表单 | **保留 URL 驱动 + `prepareLesson` 不变**;换成 Figma 的单页表单布局(SelectField 组 + 右侧摘要卡 + 输出包 + 设置 + 生成)。级联靠"GET 表单 + 小型客户端 `onChange` 提交"(复用 `prepare-url.ts`),无 JS 时有"更新"按钮降级。不可用主题灰显并说明原因(保留现有规则) |
| Material creation → "1 Select / 2 Generate / 3 Refine / 4 Export" 步进 | `/prepare` → `/jobs/[id]` → `/lessons/[id]` | 无 | 新建纯展示 `StepIndicator`(无状态,由路由推导) |
| Supporting · Generation stages | `/jobs/[id]`(`JobStatus`) | 文字状态 + 阶段 | **改**:4 步列表(课程与设置已核对 / 写题与解答 / 排版 PDF / 准备预览)按 `queued→running(stage)→succeeded` 映射;"Cancel generation" 保留现有 `cancelJobAction`。轮询/重定向/`key` 重挂载逻辑**原样保留** |
| Supporting · Validation/Error summary、Inline feedback | `messages.ts` 的错误文案 | 内联提示 | 用 `Notice` 承载**现有**文案(不改 `messages.ts` 的含义);Figma 里的示例文案不直接采用,以现有错误码文案为准 |
| Document editor(预览部分) | `/lessons/[id]` | 标签 + iframe + 对齐面板 | **改**:标题区 + "All changes saved" 徽章(无自动保存,改为"版本信息/当前版本"徽章)、`Export` 下拉/列表(逐文档 PDF 下载,沿用 `download=1`)、复核提示条(沿用 `review-reminder`)。**保留三个文档标签与 `pdf-frame`**;去掉 HTML 模拟页与自定义缩放 |
| Document editor(右栏:Document settings / Questions / Editing question) | 无 | 无 | **延后 U6**(依赖 M6 与你的决定,见 §5) |
| My materials | `/lessons` | 历史列表 + 额度 | **改**:卡片网格 + 状态徽章。搜索/筛选/排序、重命名/复制/删除、"Templates" 标签**无后端**,先不做;"Reuse settings" 可前端实现(用 `inputSpec` 预填 `/prepare`,见 U5 的只读扩展) |
| Landing(桌面/移动) | `/`(未登录) | 占位 | **新建**(静态);定价区受 D-16 与产品约束限制(见 U7) |
| (无设计)Login / Sign-up | `/login` | 简单表单 | 用同一套组件**做一版,并请你确认**(设计缺口) |
| (无设计)Account | `/account` | 邮箱 + 退出 | 同上;退出入口需要放进 `AppHeader` 的账户菜单 |

### 4.3 必须保留的 `data-testid`

`options`(含 `data-step`)、`topic-summary`、`sample-banner`、`no-curricula`、`bad-selection`、`unsupported-topic`、`allowance`、`job-status`(含 `data-state`)、`job-state`、`job-succeeded`、`document-tabs`、`document-panel`(含 `data-document`/`data-revision`)、`pdf-frame`、`open-pdf`、`download-pdf`、`lesson-title`、`review-reminder`、`alignment-panel`、`alignment-notice`、`history-list`(含行 `data-state`)。现有 Playwright 测试(`tests/e2e/*.spec.ts`)依赖它们和现有文案(如 "Generate lesson"、"Open the preview"),换皮时**文案变化必须同步更新测试并在提交说明里写明**;不能为了通过而删断言。

## 5. 缺少后端支持 / 与产品约束冲突的 Figma 交互

分三类:**A 冲突(需要你决定)**、**B 缺后端(延后或需要新增只读查询)**、**C 设计缺口(需要补稿)**。

### A. 与已批准决定或 CLAUDE.md 冲突

| # | Figma 内容 | 冲突 | 我的建议(待你决定) |
|---|---|---|---|
| A1 | 材料类型 **Worksheet / Quiz / Lesson notes** 三选一 | 后端输出包是**三份 PDF 的任意子集**(Notes / Worksheet / Solutions);没有 Quiz | 把这一组替换为"输出包"多选卡片(三份文档),视觉沿用 Figma 卡片;Quiz 不做 |
| A2 | 逐题 **Edit 题干** / **Add a question** / **Remove** / 每题难度 / "Change the point" | 数学内容不可手改(§7);M6 的调整表里有"增加练习题",**没有**"删除某题""改题干" | 题干编辑改为"仅文字字段更正"(如题目语句外的说明文字);数学参数变化只走"重新生成这一题"。需你确认是否扩充 M6 的动作表 |
| A3 | **Tutor notes · Optional** 自由文本给 LLM | `refactor-plan` §3.1:请求**无自由文本字段**;CLAUDE.md 要求把备注当数据、提示用匿名描述 | 先不做;如要做,需新决定 + 提示注入测试 |
| A4 | 预览里的**图形**、"Include a graph" 复选框;HTML 渲染的题目/答案页 | 后端不产生图形;预览必须是真实 PDF | 不做图形选项;预览用 PDF iframe |
| A5 (D-62:按原定价模型) | **定价**:3 档(£0/£12/£29)、"5 example generations / month"、Studio "最多 3 个导师工作区、共享资源" | 终身 3 次免费(CLAUDE.md §5);只有一个月度计划;团队/共享在范围外;价格/币种/额度是 D-16(未定) | 落地页默认**不放定价区**,或只放"3 次免费 + 订阅即将推出"。Figma 自己已标"Illustrative",但仍需你决定 |
| A6 | 落地页文案 "professional **LaTeX-quality** teaching materials" | D-31:LaTeX 是后端实现细节,不向用户暴露 | 营销文案去掉 "LaTeX" 字样 |
| A7 | 示例中的 **"Ontario · Grade 12 · MCV4U / Calculus"** 与 "Subject" 下拉 | MVP 目标是 Ontario **Grade 9**,当前只有明确标注的示例数据集,且现阶段只支持线性方程 | 一律从数据集渲染;**"Subject"** 在数据模型里不存在(只做数学)→ 显示为只读"Mathematics"或省略。需你确认 |

### B. 缺后端(不在本计划内修改)

| # | Figma 交互 | 状态 | 处置 |
|---|---|---|---|
| B1 | Document settings:难度变更 → "Review document changes"(新草稿修订 + 对比 + Accept/Discard)、"Answer-page choice applies at export" | M6 未开始;无草稿修订、无对比 | U6(M6 之后) |
| B2 | 逐题 Regenerate、Add/Remove、撤销删除、Regeneration failed 状态 | M6(`planAdjustment`)未实现 | U6 |
| B3 | "All changes saved" 自动保存 | 无自动保存;修订是不可变快照 | 改成"当前版本/创建时间"徽章 |
| B4 | My materials:搜索、课程/类型/排序筛选 | `listJobs` 无参数 | U5 新增**只读、按 owner 过滤**的 DAL 查询(含 `Lesson.inputSpec` 摘要字段),附越权测试;或先隐藏筛选区 |
| B5 | Rename / Duplicate / Delete | 无 DAL;删除还涉及 CLAUDE.md §9 的"先阻断发布再清理"、Storage RLS 已知限制(D-48);复制是否算"新生成"需定义 | 延后到 Phase 3 的历史/删除工作;U5 不显示这些按钮 |
| B6 | "Reuse settings" | 可用 `Lesson.inputSpec` 预填 `/prepare` | U5(前端 + 上面的只读查询) |
| B7 | Dashboard 缩略图、Saved for later、Start with a template、Your defaults / Manage defaults | 无缩略图生成、无收藏、无模板、无用户偏好表 | 不做;如要做,各自需要决定(缩略图需后端渲染 PDF 首页) |
| B8 | 头像 "JD"、"Jane Doe"、PDF 署名 "Only your name appears on the PDF" | `Profile` 没有显示名称;模板是否带署名未定义;隐私默认只收集账户信息 | 界面先显示邮箱/首字母;署名需要新决定(涉及模板与隐私文案) |
| B9 | 导出状态(Exporting / Ready / Failed / Saving) | 现有导出就是签名 URL 直接下载,无"导出作业" | 用 `Notice` 表达下载失败/预览不可用等**现有**状态;不虚构异步导出 |

### C. 设计缺口(请补稿或授权我按设计系统自行拟定)

1. 剩余额度显示(CLAUDE.md §1 要求"查看剩余额度")、额度用完状态、订阅/账单入口(Phase 3 前先放占位文案,沿用现有 "Subscriptions are not available yet")。
2. 示例数据集横幅(D-30 要求界面标注"示例,非真实课程")与课程对齐面板(对齐声明必须可追溯到数据集)。
3. 登录/注册、账户页、账户菜单(退出)。
4. 标题文字样式(Lora 各级字号)未作为变量;页面标题之外的字号需从画板读取。
5. 生成失败/取消/排队重试(`Waiting to retry`)的状态稿——补充状态里有"失败+保留输入",但没有 queued/retry。
6. 空状态:无历史时的列表(补充状态有"Empty document",可复用)。

## 6. 实施里程碑

命名为 **U0–U7**,与后端里程碑(M6/M7/CM)区分。每个里程碑一个 `feat/ui-<slug>` 分支,合并前:`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e` 全过,并在 390px 与 1440px 下与 Figma 截图对照。**依赖顺序**:U0 → U1 → U2/U3/U4(可并行)→ U5 → U7;U6 依赖 M6。

### U0 — 决定与设计澄清(**已完成**:D-58–D-64;其余默认见 §0)
- (原计划)你回答 §5 的 A1–A7、B8、B4/B5 的取舍;补 §5-C 的设计缺口,或授权我按设计系统拟定并由你验收。
- **验收**:每个 A/B/C 项有"做 / 不做 / 延后"的结论,记入 `docs/decisions.md`(新决定编号)。
- **回滚**:无。

### U1 — 令牌、字体、共享组件、应用外壳(无行为变化)
- **Files:** Modify `src/app/globals.css`、`src/app/layout.tsx`、`src/components/ui/button.tsx`、`src/components/site-nav.tsx`;Create `src/components/ui/{badge,notice,select-field,checkbox-row,text-action,card}.tsx`、`src/components/app/{app-header,workspace-nav,logo}.tsx`、`public/brand/*.svg`(从 Figma 下载)、`src/app/(app)/layout.tsx`(路由组,给登录后页面加侧栏外壳,**不改 URL**)。
- **Interfaces(Produces):** `Notice({intent:"error"|"success"|"progress", children, ...rest})`(透传 `data-testid`/`role`);`SelectField({label, name, options, hint?, error?, ...})`;`CheckboxRow`;`Badge`;`TextAction`;`WorkspaceNav({current})`。`lib/ui/*` 不变。
- **Steps:**
  - [ ] 写 `tests/unit/ui-tokens.test.ts`:断言 `globals.css` 含全部 §3.1 令牌值(防止后续漂移)。
  - [ ] 令牌与字体落地;`button.tsx` 变体对齐。
  - [ ] 逐个共享组件:先写渲染/可访问性单测(role、`aria-invalid`、最小触控尺寸类),再实现。
  - [ ] 外壳:移动端导航;未登录页面(`/login`)不使用侧栏。
  - [ ] 把现有页面中的内联 `rounded border p-3` 提示替换为 `Notice`,**不改文案与 testid**。
- **验收:** 现有全部单元/E2E 测试不改断言即通过;页面视觉出现新外壳与令牌。
- **风险:** 字体构建期下载;`(app)` 路由组与 `proxy.ts` 的匹配(应无影响,需验证)。
- **回滚:** 单个分支整体回退;未触碰后端。

### U2 — Material creation(`/prepare`)
- **Files:** Modify `src/app/prepare/page.tsx`;Create `src/components/app/prepare-form.tsx`(客户端,仅负责 onChange 导航)、`src/components/app/package-summary.tsx`、`src/components/app/step-indicator.tsx`;`prepare/actions.ts` **不改**。
- **要点:** 级联选项始终由服务端 `dal.curriculum.getSelectionOptions/getSelectionPath` 决定(不在客户端筛选);不可用选项灰显并保留原因文案;主题摘要保留课程目标与"Builds on";输出包 = 三份文档多选(A1);难度沿用 `basic/mixed/challenge`,时长沿用 30–120 分钟;额度用完时按钮禁用并保留现有提示;示例数据横幅保留。
- **验收:** `tests/e2e/prepare.spec.ts` 在更新选择器后仍覆盖:依赖选择、不支持主题的服务端拒绝、幂等键;新增 390px 截图检查;无 JS 时仍可提交。
- **风险:** 把逐级链接改成下拉后,URL 状态与现有 `prepare-url.ts` 的 `upTo` 语义要保持(单测覆盖)。

### U3 — 生成进度(`/jobs/[id]`)
- **Files:** Modify `src/components/job-status.tsx`、`src/app/jobs/[id]/page.tsx`;Create `src/lib/ui/job-steps.ts`(纯函数:`jobSteps(job): {label, state:"done"|"active"|"todo"}[]`)。
- **验收:** 单测覆盖 queued/running 四个阶段/retrying/failed/canceled/succeeded;E2E 刷新、返回键不丢作业、不产生重复消耗(沿用现有测试);取消仍走 `cancelJobAction`。
- **风险:** 阶段名与 Figma 四步的映射(`generating`→写题;`validating`→写题的后半;`compiling`→排版;`storing`→准备预览),已在纯函数里集中。

### U4 — 课包页(`/lessons/[id]`)
- **Files:** Modify `src/app/lessons/[id]/page.tsx`;Create `src/components/app/export-menu.tsx`(服务端渲染的链接列表,沿用 `fileUrl`)。
- **要点(D-60):** 新增**HTML 草稿预览**标签(由 `LessonRevision` 的结构化内容在服务端渲染成 React,数学用 KaTeX,宏白名单;**不执行任何 LaTeX、不渲染不受信 HTML**),标注"草稿预览,以导出的 PDF 为准";**PDF 标签与 `pdf-frame` 保留**,导出仍是编译 PDF。两者共享同一 `revisionId` 与题目稳定 ID。保留 `document-tabs`/`pdf-frame`/`open-pdf`/`download-pdf` 与"同一 `revisionId`"规则;右栏放"文档信息 + 课程对齐面板(原 `alignment-panel`)"而不是未实现的编辑面板;AI 复核提示保留。
- **新增依赖:** `katex`(固定精确版本,按 CLAUDE.md §3 先查已装版本与官方文档;样式表本地打包,不走 CDN)。
- **验收:** `lesson-preview.spec.ts` 通过;跨用户越权与缓存头测试不变;预览与下载链接都带同一 `rev`;新增一致性测试:同一修订下 HTML 预览与 PDF 清单的文档集合、题目 ID 与答案对应关系一致;含恶意字符串(`<script>`、`\\input`、URL)的内容在 HTML 中被转义。
- **风险(D-60):** 第二套渲染器可能与 PDF 出现排版/内容漂移——HTML 只渲染结构化内容的同一视图模型(新建 `src/lib/package/html-view.ts` 纯函数),不重新解释数学;PDF 仍是唯一"最终"产物。
- **风险:** 内嵌 PDF 的移动端兼容(既有降级链接保留)。

### U5 — Dashboard 与 My materials
- **Files:** Create `src/app/(app)/dashboard/page.tsx`、`src/components/app/material-card.tsx`;Modify `src/app/lessons/page.tsx`、`src/app/page.tsx`(登录后重定向);**可能**新增 `src/lib/server/dal/history.ts` 的只读方法 `listMaterials(ctx, filters)`(owner 过滤、参数校验、分页)。
- **后端改动理由:** 卡片需要 `Lesson.inputSpec`/课程主题名/文档类型/更新时间,`listJobs` 不提供;只增加只读查询,不动写路径。
- **验收:** 集成测试(真实 Postgres):只返回本人课包;筛选/排序参数被服务端校验;跨用户读取被拒;已有 `history.test.ts` 不改。
- **风险:** 范围蔓延(缩略图、模板、收藏、重命名/复制/删除)——**明确不做**,见 §5-B。

### U6 — 编辑器工具(**要做**,D-61;阻塞于 M6 后端)
- 范围:文档设置 + 调整面板、题目列表(Edit 文字字段 / Regenerate / Remove / Add / 单题难度 / 换同类题)、实时 HTML 预览反馈、修订对比与接受/放弃、撤销、失败保留。
- 顺序:M6 后端(`planAdjustment`、执行器、草稿修订、D-33 额度默认值)先做并通过;U6 再接 UI。**不在 M6 完成前交付任何空壳控件。**
- **前置:** M6 的 `planAdjustment` 与执行器、草稿修订、D-33 额度默认值、"删除某题"动作是否加入调整表。
- **验收(预告):** 未受影响的节哈希逐字节相同;失败不改变原修订并返还;数学内容不可手改;调整幂等。

### U7 — 落地页(`/`,未登录)与登录/账户
- **Files:** Create `src/app/(marketing)/page.tsx` 或在 `src/app/page.tsx` 分支;`src/components/marketing/*`;Modify `src/app/login/page.tsx`、`src/app/account/page.tsx`。
- **要点:** 静态、服务端渲染;图片/插画从 Figma 下载并入库;定价区按 D-62 只放**一个**月度计划 + "3 次免费生成"卡片,金额/额度读配置并标 `TEST VALUE`,不做三档/Studio;"LaTeX" 字样可保留(D-64),但不出现"你可以编辑 LaTeX/下载 .tex"之类承诺;页脚的隐私/条款链接在 D-18 隐私政策完成前不放死链接。
- **验收:** 桌面/移动截图对照;Lighthouse/axe 无阻断问题;所有文案经"不夸大、不承诺零错误、不声称课程对齐"检查。

## 7. 风险与依赖

| 风险 | 影响 | 缓解 |
|---|---|---|
| 设计假设了未实现的编辑器(M6) | 大块 UI 无后端可接 | U6 单列并阻塞;其间不上空壳控件 |
| 设计与产品约束冲突(A1–A7) | 做完再返工 | U0 先决定 |
| 字体构建期下载 / 许可证 | CI 或离线构建失败 | 先验证 `next/font/google`;备选自托管 |
| 改动 `/prepare` 破坏幂等/服务端校验 | 重复消耗额度、越权选择 | `prepareLesson` 不改;沿用幂等键测试;选项始终服务端算 |
| 文案变化导致 E2E 断言失败 | 误以为回归 | 同步改选择器并在提交说明列出;保留 testid |
| 路由组/外壳影响会话刷新与缓存头 | 跨用户缓存、登录态丢失 | 保持 `proxy.ts` 不变;跑现有缓存头与越权测试 |
| Figma 示例文案被当成事实 | 不真实的课程声明 | 课程/编码一律从数据集渲染;文案走 `messages.ts` |
| 范围蔓延(缩略图/模板/收藏/默认设置) | 工期与后端扩张 | §5-B 明确"不做",需另立决定 |

**依赖:** 你对 U0 的答复;(U6)M6 后端;(U7 定价)D-16;(隐私/页脚)D-18;(真实课程文案)CM 里程碑。

## 8. 验证与测试策略

- **每个里程碑的门禁:** `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e`;涉及 DAL 的(U5)加 `pnpm test:integration`。
- **不弱化既有保证:** 现有 E2E(选择、骨架路径、预览)、跨用户矩阵、缓存头、Storage/RLS 测试保持不变且必须通过;预览与下载使用同一 `revisionId` 的断言不改。
- **新增单测:** 令牌存在性;`jobSteps`;`prepare-url` 的级联语义;共享组件的 a11y 属性(role、`aria-invalid`、触控尺寸);落地页文案禁词检查("LaTeX"、"零错误"等)。
- **视觉对照:** 每个页面用 Playwright 截取 1440 与 390 宽度,与 Figma 截图人工并排核对(记录在 PR/提交说明);不在 CI 里做像素级回归,待布局稳定后再在固定环境里加基线(与 CLAUDE.md §8 "固定环境、非二进制比较"一致)。
- **可访问性:** 键盘可达、焦点可见(`--ring`)、对比度(Figma 令牌本身需核对:`text/secondary #626d67` on `#f8f7f3` 等)、触控 ≥ 44px、`aria-live` 保持;是否引入 `@axe-core/playwright` 是新依赖,需你同意后再加。
- **未运行的检查(诚实声明):** 本阶段没有运行任何代码、测试或构建;以上全部是计划。真实认证/Storage/沙箱的端到端验证仍按 CLAUDE.md §11 的发布前要求另行进行。

## 9. 下一步

请评审并回答 U0 的问题。批准后,我会先按 U1 写出逐步(测试先行)的任务清单并实施,再依次推进;评估/验证用独立的 evaluator 与 validator 子代理,最多 3 轮评估循环(CLAUDE.md 开发流程)。

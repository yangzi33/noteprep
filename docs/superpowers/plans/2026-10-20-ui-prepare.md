# U2:Material creation(`/prepare`)按 Figma 重排 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/prepare` 从"逐级点链接"的向导改成 Figma 的单页表单布局(下拉选择 + 右侧摘要 + 输出包卡片 + 设置 + 生成),课程数据继续完全来自数据集,`prepareLesson` 与生成行为不变。

**Architecture:** 页面仍是服务端渲染、URL 驱动(`prepare-url.ts` 的 `PrepareParams`/`upTo`/`prepareHref` 保持不变)。每个下拉的选项由服务端用 `getSelectionOptions` 按"已选前缀"算出;一个很小的客户端组件在下拉变化时 `router.push` 到清除了后续步骤的新 URL。选项的纯逻辑放进 `src/lib/ui/prepare-view.ts`(单测覆盖)。

**Tech Stack:** Next.js 16 App Router、React 19、Tailwind 4、Vitest(`renderToStaticMarkup`)、Playwright。

**Spec:** `docs/superpowers/plans/2026-10-20-figma-ui-implementation.md`(§0 决定 D-58–D-64、§4.2 页面映射、§6 U2);U1 计划 `docs/superpowers/plans/2026-10-20-ui-foundation.md`(组件契约);Figma 画板 `49:13060`(桌面)/`49:13236`(移动),高保真代码已保存在 `/home/yangzi33/.claude/projects/-home-yangzi33-noteprep/55981a97-2fbc-4f89-8500-de423ad8c3ae/tool-results/toolu_01QU2sMbcuPiao6FoVpZ6Gim.json`(JSON,`[0].text` 是参考 React 代码,**只作视觉参考,不照抄**;图标用 `lucide-react` 的同名图标)。

## Global Constraints

- 不改后端:`src/lib/server/**`、`worker/**`、`prisma/**`、`src/lib/latex/**`、`src/app/prepare/actions.ts`(`prepareLesson`)、`createLesson` 一律不动。服务端仍然拒绝不支持的主题与不一致的选择。
- 课程/级别/课程/单元/主题的名称与文案**只来自数据集**(D-63),不得硬编码任何课程;"Subject"不单独出现(数据集没有该层)。
- 输出类型就是现有三份文档(D-59):`notes`/`worksheet`/`solutions`,表单字段名 `documents`,默认全选,至少选一份(服务端已校验);**不做 Quiz、不做图形选项、不做"Advanced options"、不做 Tutor notes**。
- 必须保留的文案与钩子(现有 E2E/冒烟依赖):按钮文字 `Generate lesson`;额度文字 `data-testid="allowance"` 内容精确为 `N of M generations left.`(可带 ` (K in progress)` 后缀,沿用现有格式);`sample-banner`、`no-curricula`、`bad-selection`、`unsupported-topic`、`topic-summary`(含目标与"Builds on")的 testid 与其文字内容;`getByLabel("Tutor Lesson Notes")`、`getByLabel("Solutions / Answer Key")`、`getByLabel("Student Practice Worksheet")` 必须能定位到对应 checkbox;额度用完时 `Notice` 带显式 `role="status"` 且文案不变;页面同一时刻最多一个 `role="status"`。
- 隐藏字段与 `key`(幂等键,每次渲染一个 `randomUUID()`)保持现有行为;`name` 为 `key`、`v`、`level`、`course`、`unit`、`topic`、`durationMinutes`、`difficulty`、`documents`。
- 级联下拉依赖 JS(`router.push`);生成表单本身(POST `prepareLesson`)不依赖 JS。README/计划里如实写明这一点。
- 可点击控件 `min-h-11`,焦点环用 `--ring`;错误不只靠颜色。不新增依赖。
- E2E 不能在 WSL 里跑(无 Docker):对 E2E 的任何改动都必须保持**同等覆盖**并在提交说明里列出"旧断言 → 新断言";报告里写明"E2E 未运行,需用户在有 Docker 的机器上运行"。
- 代码标识符与注释用英文;提交信息英文,末尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`;只按明确路径 `git add`;在 `feat/ui-prepare` 上提交,不推 `main`。

## Review Focus

- 选中的下拉值必须与 URL 同步:刷新、后退、手改 URL 后页面状态一致;改动较早的步骤必须清掉后面的值(否则会提交过期的 `topic`)→ Task 1 的 `changeSelection` 测试 + Task 5 的 E2E。
- 手改 URL 指向不支持主题/不一致选择时,页面仍给出礼貌提示且**没有**生成表单(服务端仍是最终防线)→ Task 4。
- 不支持的主题在下拉里是**禁用**项并带原因,不是隐藏,也不能被选中 → Task 1/4。
- 数据集没有"级别"层(synthetic-nolevels)时页面不应出现空的级别下拉 → Task 1 的测试用该形状。
- 额度用完:生成按钮禁用且显示原因,但页面仍可浏览选择 → Task 4。

---

### Task 1: 选项视图模型(纯函数)

**Files:**
- Create: `src/lib/ui/prepare-view.ts`
- Test: `tests/unit/prepare-view.test.ts`

**Interfaces:**
- Consumes: `PrepareParams`、`PrepareStep`、`upTo`、`prepareHref` from `@/lib/ui/prepare-url`;类型 `SelectionOption`、`SelectionStep`、`CurriculumSummary` from `@/lib/server/dal/curriculum`(只 `import type`)。
- Produces:
  - `type FieldKey = "v" | "level" | "course" | "unit" | "topic"`
  - `interface SelectFieldView { key: FieldKey; label: string; value: string; options: { value: string; label: string; disabled: boolean }[]; disabled: boolean; placeholder: string }`
  - `buildSelectFields(input: { curricula: Pick<CurriculumSummary, "id" | "name" | "latestVersionId">[]; params: PrepareParams; steps: SelectionStep[]; stepOptions: Partial<Record<SelectionStep, SelectionOption[]>> }): SelectFieldView[]` — 顺序固定为 `v`、(`level` 仅当 `steps` 含 `"level"`)、`course`、`unit`、`topic`;标签依次为 `Curriculum`、`Level`、`Course`、`Unit`、`Topic`;每个字段 `value` = `params[key] ?? ""`;`v` 的选项来自 `curricula`(`value = latestVersionId`,`label = name`,全部可选);其余字段的选项来自 `stepOptions[step]`(`value = id`);主题选项的 `label` 在 `coverage === "partial"` 时追加 ` (partly covered)`;`supported === false` 的选项 `disabled: true`,且 `label` 追加 ` — not available yet`(主题)或 ` — nothing here is available yet`(其他层,与现有文案一致);一个字段 `disabled` 当且仅当它之前的某个字段 `value` 为空;`placeholder` = `Choose a <label.toLowerCase()>`。
  - `changeSelection(params: PrepareParams, key: FieldKey, value: string): PrepareParams` — 返回 `{...upTo(params, key), [key]: value || undefined}`,即**清除该字段之后的所有值**;`key === "v"` 时只保留新的 `v`。
  - `selectionHref(params: PrepareParams, key: FieldKey, value: string): string` — `prepareHref(changeSelection(params, key, value))`。

- [ ] **Step 1: 写失败测试** `tests/unit/prepare-view.test.ts`:
  - `changeSelection({v:"a",level:"l",course:"c",unit:"u",topic:"t"}, "course", "c2")` 等于 `{v:"a",level:"l",course:"c2"}`(unit、topic 被清除);`changeSelection(..., "v", "b")` 等于 `{v:"b"}`;`value` 为空串时该键为 `undefined`。
  - `selectionHref` 对上例得到 `/prepare?v=a&level=l&course=c2`(顺序固定为 v、level、course、unit、topic)。
  - `buildSelectFields`:含 level 步骤时返回 5 个字段、键序 `v,level,course,unit,topic`;`steps` 不含 `"level"` 时返回 4 个字段且没有 `level`;`params` 为空时 `level`/`course`/`unit`/`topic` 均 `disabled: true`,`v` 不禁用;`unit` 选项里 `supported:false` 的项 `disabled:true` 且 label 以 ` — nothing here is available yet` 结尾;`topic` 里 `coverage:"partial"` 的项 label 以 ` (partly covered)` 结尾,`supported:false` 的主题以 ` — not available yet` 结尾且 `disabled:true`;`value` 取自 params。
- [ ] **Step 2: 运行确认失败** — `pnpm exec vitest run tests/unit/prepare-view.test.ts`。
- [ ] **Step 3: 实现** 上述类型与函数(纯函数,无副作用,不读环境)。
- [ ] **Step 4: 运行** 目标测试通过;`pnpm test`、`pnpm lint`、`pnpm typecheck` 通过。
- [ ] **Step 5: 提交** — `git add src/lib/ui/prepare-view.ts tests/unit/prepare-view.test.ts`;`git commit -m "ui: selection view model for the prepare form"`。

---

### Task 2: SelectField 增加 onChange/disabled + 客户端选择器

**Files:**
- Modify: `src/components/ui/select-field.tsx`、`tests/unit/ui-controls.test.ts`
- Create: `src/components/app/selection-fields.tsx`
- Test: `tests/unit/ui-controls.test.ts`(追加用例)

**Interfaces:**
- Consumes: Task 1 的 `SelectFieldView`、`selectionHref`;`SelectField`(现有);`useRouter` from `next/navigation`。
- Produces:
  - `SelectField` 新增可选 props:`onChange?: React.ChangeEventHandler<HTMLSelectElement>`、`disabled?: boolean`、`testId?: string`(渲染为 `<select data-testid="…">`)、`placeholder?: string`(有 `placeholder` 时在最前渲染 `<option value="">`,并**不**设为 disabled,以便"未选择"状态可见);`disabled` 渲染原生 `disabled` 属性并使用 `text-text-disabled bg-action-disabled`。其余 U1 行为不变。
  - `SelectionFields({ fields, params }: { fields: SelectFieldView[]; params: PrepareParams })` — `"use client"`;渲染一个 `<div data-testid="selection-fields">`,里面每个字段一个 `SelectField`(`name={field.key}`,`defaultValue={field.value}`,`key={\`${field.key}:${field.value}\`}` 使 URL 变化时重挂载,`placeholder`、`disabled`、`options` 取自视图模型);`onChange` 调 `router.push(selectionHref(params, field.key, event.target.value))`;每个字段传 `testId={\`select-${field.key}\`}`;布局:`v`/`level`/`course` 在同一行(`grid gap-4 sm:grid-cols-3`,没有 level 时 `sm:grid-cols-2`),`unit` 与 `topic` 各占一行。

- [ ] **Step 1: 写失败测试**(追加到 `tests/unit/ui-controls.test.ts`,`renderToStaticMarkup`):`SelectField` 传 `disabled` → 输出 `<select … disabled=""`(用 `/<select[^>]*\sdisabled=""/` 匹配,不能只 `toContain("disabled")`);传 `placeholder="Choose a topic"` → 第一个 `<option value="">Choose a topic</option>` 且没有 `disabled`;未传 `disabled` 时不出现 `disabled=""`。`SelectionFields` 渲染测试:给两个字段(一个禁用)→ 输出含 `data-testid="selection-fields"` 与两个 `<select`,禁用的那个带 `disabled=""`;`defaultValue` 对应的 `<option … selected>`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现** `SelectField` 的三个新 prop(保持无 `"use client"`:`onChange` 只在被客户端组件使用时才有意义)与 `SelectionFields`。
- [ ] **Step 4: 运行** 目标测试 + `pnpm test`、`pnpm lint`、`pnpm typecheck`。
- [ ] **Step 5: 提交** — 明确列出路径;`git commit -m "ui: SelectField onChange/disabled/placeholder and the prepare selection fields"`。

---

### Task 3: 展示组件(StepIndicator、PackageOption)

**Files:**
- Create: `src/components/app/step-indicator.tsx`、`src/components/app/package-option.tsx`
- Test: `tests/unit/prepare-components.test.ts`

**Interfaces:**
- Consumes: U1 的令牌与 `Badge`/`Card` 约定;`lucide-react`。
- Produces:
  - `StepIndicator({ steps, current }: { steps: readonly string[]; current: number }): JSX.Element` — `<ol aria-label="Progress">`,每项 `<li>` 显示 `"{i+1} {label}"`(Figma 的 "1 Select / 2 Generate / 3 Refine / 4 Export" 样式),当前项 `aria-current="step"` 且加 `bg-accent text-text-accent font-semibold`;其余 `text-muted-foreground`。**纯展示,不是导航**。
  - `PackageOption({ id, name, value, label, description, defaultChecked, disabled }: { id: string; name: string; value: string; label: string; description: string; defaultChecked?: boolean; disabled?: boolean }): JSX.Element` — 卡片容器(`rounded-notice border` 样式,选中态用 `has-[:checked]:` 的 `border-ring bg-accent`);原生 `<input type="checkbox" id name value>`、**`<label htmlFor={id}>` 只包含 `label` 文字**(使无障碍名称恰为 `label`)、`<p id={id+"-desc"}>` 放 `description`,input 带 `aria-describedby`;整张卡片可点击(label 用伪元素铺满 `after:absolute after:inset-0`),`min-h-11`。

- [ ] **Step 1: 写失败测试**:`StepIndicator` 输出含 4 个 `<li>`、第 2 项 `aria-current="step"`、文本含 `2 Generate`;`PackageOption` 输出 `<input type="checkbox"` 的 `id` 等于 `<label for>`、label 内文字恰为 `Tutor Lesson Notes`(正则 `<label[^>]*>Tutor Lesson Notes</label>`)、`aria-describedby` 指向描述元素 id、`defaultChecked` → `checked`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**两个组件(服务端组件,无 `"use client"`)。
- [ ] **Step 4: 运行** 目标测试 + `pnpm test`、`pnpm lint`、`pnpm typecheck`。
- [ ] **Step 5: 提交** — `git commit -m "ui: StepIndicator and PackageOption components"`。

---

### Task 4: 重排 `/prepare` 页面

**Files:**
- Modify: `src/app/prepare/page.tsx`
- Create: `src/components/app/topic-summary.tsx`(仅当抽出能让页面更清楚;否则内联)
- Test: 无新单测(逻辑已在 Task 1–3);靠 `pnpm build` 与 Task 5 的 E2E

**Interfaces:**
- Consumes: Task 1–3 的 `buildSelectFields`、`SelectionFields`、`StepIndicator`、`PackageOption`;U1 的 `Card`、`Badge`、`Notice`、`SelectField`、`Button`;`dal.curriculum.listCurricula/getSelectionSteps/getSelectionOptions/getSelectionPath/resolveCurriculumContext`、`dal.history.getAllowance`、`prepareLesson`(均为现有)。
- Produces: 页面结构(桌面 `lg:grid-cols-[minmax(0,1fr)_320px]`,移动端单列):
  1. 页头:小标题 `CREATE MATERIAL`(`text-[11px] font-semibold tracking-[0.16em] text-text-accent`)、`h1`(`font-heading text-[34px] leading-[1.2]`)文字 `Prepare a lesson pack`、副标题 `A few familiar choices. Three documents shaped around your lesson.`、`StepIndicator steps={["Select","Generate","Preview","Export"]} current={0}`、额度文字(`data-testid="allowance"`,格式沿用现有)、`params.error` 的 `Notice intent="error"`。
  2. 主卡片(`Card`):标题 `Start with your teaching context`;`<SelectionFields>`(`v`、可选 `level`、`course`、`unit`、`topic`);示例数据集时 `Notice intent="info" data-testid="sample-banner"` 文案**不变**;选择尚未到主题时,下方提示 `Choose a topic to continue.`。
  3. 选择了**受支持**的主题后,同一卡片内继续显示:`Output package` 三个 `PackageOption`(`name="documents"`,值/标签/描述分别为 `notes`/`Tutor Lesson Notes`/`For you: explanations, worked examples and a teaching sequence`,`worksheet`/`Student Practice Worksheet`/`For the student: practice questions with space to write, no answers`,`solutions`/`Solutions / Answer Key`/`For you: answers and worked steps for the worksheet`,描述文案取自 `DOCUMENT_PURPOSE`,全部 `defaultChecked`)、`Settings`(两个 `SelectField`:`name="durationMinutes"`(30/45/60/90/120 minutes,默认 60)、`name="difficulty"`(`basic`/`mixed`/`challenge`,标签 `Basic`/`Mixed (easy to hard)`/`Challenge`,默认 `mixed`))、`Choosing fewer documents still uses one generation.`、整宽主按钮 `Generate lesson`(`type="submit"`,额度用完时 `disabled`)。这些控件都在**一个** `<form action={prepareLesson}>` 里,并带隐藏字段 `key` 与 `v/level/course/unit/topic`(沿用现有)。
  4. 右栏(`aside`):`Card` + `Badge` `YOUR LESSON PACK`,`data-testid="topic-summary"` 容器,内容沿用现有(主题标题、`Learning objectives` 列表含 partial 说明、`Builds on` 列表),再加 `Format` 行 `A4 · Print-ready PDF`;下面一段说明文字 `Next, review the preview, then export your PDFs.`(不提 Refine/调整,M6 之前不存在)。
  5. 状态分支(沿用现有逻辑与文案、testid):没有任何课程 → `no-curricula`(含指向 `/lessons/new` 的 "quick form" 链接);`getSelectionPath` 抛 `CURRICULUM_NOT_FOUND`/`INVALID_SELECTION` → `bad-selection` 的 `Notice`(含 "Start again" 链接);所选主题不受支持 → `unsupported-topic` 的 `Notice`(含 "Back to the topics" 链接,指向 `prepareHref(upTo(params,"unit"))`),**不渲染生成表单**;额度用完 → `Notice intent="info" role="status"` 文案不变。
- 选项数据:`const steps = await dal.curriculum.getSelectionSteps(v)`;对每个**已有前缀**的步骤调用 `getSelectionOptions`(level 用 `{versionId}`;course 用 `{versionId, levelId}`(无 level 层时 `{versionId}`);unit 用 `{versionId, levelId, courseId}`;topic 用 `{versionId, levelId, courseId, unitId}`),放进 `stepOptions`;再 `buildSelectFields`。

- [ ] **Step 1: 基线** — 记录改动前 `pnpm test`、`pnpm lint`、`pnpm typecheck` 通过。
- [ ] **Step 2: 重写页面**(保持 `export default async function PreparePage` 与 `requireAccount()`;保留 `domainErrorCode` 的错误处理分支;删除不再使用的 `Crumbs`、`STEP_TITLE`、逐级链接列表与 `inputClass`;不留未使用的 import)。
- [ ] **Step 3: 运行** `pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm build` 全部通过。
- [ ] **Step 4: 尽力视觉检查** — 若能启动应用则 1440px 与 390px 截图对照 Figma `49:13060`/`49:13236`;不能则如实写"未做"。
- [ ] **Step 5: 提交** — `git add src/app/prepare/page.tsx`(及新建文件);`git commit -m "ui: single-page prepare form with selection fields, package options and summary"`。

---

### Task 5: 更新依赖旧向导的 E2E

**Files:**
- Modify: `tests/e2e/prepare.spec.ts`;必要时 `tests/e2e/lesson-preview.spec.ts`、`tests/smoke/staging.spec.ts`(仅当它们依赖已删除的元素;它们用直接 URL + `Generate lesson` 按钮 + `getByLabel`,预期无需改)

**Interfaces:**
- Consumes: Task 4 的页面;`data-testid`:`selection-fields`、`select-v`、`select-level`、`select-course`、`select-unit`、`select-topic`、`sample-banner`、`topic-summary`、`allowance`、`bad-selection`、`unsupported-topic`。

旧 → 新对照(覆盖必须等价,逐条写进提交说明):

| 旧断言 | 新断言 |
|---|---|
| 点链接选课程/级别/课程/单元,`options` 的 `data-step` 依次为 level/course/unit | `select-v` `selectOption({label:"Sample Mathematics (not a real curriculum)"})` 后 `sample-banner` 可见、`select-level` 可用;依次 `selectOption` 级别、课程(`/Sample Course 1/`)、单元,每步断言下一级下拉由禁用变为可用且 URL 含对应参数 |
| 主题列表 3 项,第 3 项含 `(partly covered)` | `select-topic` 的 3 个选项(不含占位项),其中一项文字含 `(partly covered)` |
| 点主题链接后 `topic-summary` 含目标与前置 | `selectOption` 主题后 `topic-summary` 含 `Sample objective: solve one-unknown equations` 与 `Solving equations with one unknown` |
| 点 `Generate lesson` → `/jobs/…` → 课包页 → 额度 `2 of 3` | 不变 |
| 不支持的单元下:唯一选项 `data-unsupported` 且无链接 | `select-unit` 里该选项带 `disabled` 属性且文字含 `nothing here is available yet`;不支持的主题:手改 URL 后 `unsupported-topic` 可见且无 `Generate lesson` 按钮(不变) |
| 不一致选择 → `bad-selection`(不变) | 不变 |
| 刷新/后退:`data-step` 为 course → level | 选完 level 后 `reload`:`select-level` 的值仍是所选级别、`select-course` 可用;`goBack` 后 `select-level` 回到未选、`select-course` 禁用 |
| 未登录跳转登录(不变) | 不变 |

- [ ] **Step 1: 重写 `prepare.spec.ts` 中受影响的用例**,按上表一一对应,使用 Playwright 的 `selectOption`(按 label 或 value);不要删除任何一个测试用例,不要降低覆盖。
- [ ] **Step 2: 静态检查** — `pnpm lint`、`pnpm typecheck`(含 tests/e2e 的类型)通过;**不能运行 E2E**(无 Docker),在报告里写明"E2E 未运行"并列出每个新断言依赖的页面元素。
- [ ] **Step 3: 提交** — `git add tests/e2e/prepare.spec.ts`(及实际改动的其他 spec);提交说明里粘贴"旧 → 新"对照;`git commit -m "test: update the prepare E2E for the single-page selection form"`。

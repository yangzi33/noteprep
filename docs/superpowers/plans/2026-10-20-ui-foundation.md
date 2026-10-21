# UI 基础(U1):设计令牌、字体、共享组件、应用外壳 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Figma 的设计令牌、字体、共享控件和应用外壳落到现有前端上,不改变任何页面的行为、文案或 `data-testid`。

**Architecture:** 沿用 shadcn 的语义 CSS 变量名(使现有 `button.tsx` 自动继承),Figma 独有角色用新变量;共享控件做成无状态的服务端友好组件(原生 `<select>`/`<input>`),放 `src/components/ui/`;应用外壳在根 `layout.tsx` 里按登录状态切换(**不**使用路由组,避免搬动页面文件)。

**Tech Stack:** Next.js 16 App Router、React 19、Tailwind CSS 4(`@theme inline`)、`class-variance-authority`、`lucide-react`、`next/font/google`、Vitest(node 环境,组件用 `react-dom/server` 的 `renderToStaticMarkup` 测)、Playwright。

**Spec:** `docs/superpowers/plans/2026-10-20-figma-ui-implementation.md`(§0 决定、§3 令牌、§4 组件映射、§6 U1);`docs/decisions.md` D-58–D-64;Figma 文件 `PurgKHaONJxdKzjIoeuPoi`(令牌取自节点 `35:812`,外壳取自 `49:15878`/`54:553`/`54:610`)。

## Global Constraints

- 不改任何页面的流程、文案或 `data-testid`;现有单元测试与 E2E **不改断言**即通过(CLAUDE.md §2:不删除/不放宽测试)。若某个选择器必须随结构变化,在提交说明里写明原因,断言含义不变。
- 不碰后端:`src/lib/server/**`、`worker/**`、`prisma/**`、`src/lib/latex/**` 一律不改。`prepareLesson`、`createLesson`、`cancelJobAction`、`signOut` 不改。
- 可点击控件最小高度 44px(`min-h-11`);焦点环用 `--ring`;错误不只靠颜色(文字 + `aria-invalid`/`role`)。
- 页面上同一时刻最多一个 `role="status"` 元素(现有 E2E `getByRole("status")` 是严格模式)。
- `.dark` 变量块不改;不新增依赖(`next/font`、`lucide-react`、`cva` 已有)。
- 代码标识符与注释用英文;提交信息英文,末尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`;只按明确路径 `git add`(禁止 `git add -A`),提交前看 `git status` 与 `git diff --cached`;在 `feat/ui-foundation` 上提交,不推 `main`。
- 组件测试文件放 `tests/unit/*.test.ts`(Vitest 只收 `.ts`),用 `React.createElement` + `renderToStaticMarkup`。
- 检查命令以 `package.json` 为准:`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`;E2E 是 `pnpm test:e2e`(需要先 `pnpm supabase:start`,依赖 Docker;不可用时如实报告"未运行")。

## Review Focus

- 控件在无 JS 时必须可用(原生 `select`/`checkbox`,表单提交不依赖客户端状态)→ Task 3 的测试断言输出的是原生元素。
- `getByLabel("Tutor Lesson Notes")` 这类按标签文本找 checkbox 的现有测试:新的 `CheckboxRow` 必须仍是"input 包在 label 里,标签文本可被读取" → Task 3 测试。
- 外壳加入后,页面上不得出现第二个 `role="status"`,也不得出现嵌套 `<main>`;登录后的导航在移动端不得造成横向滚动 → Task 4/5 的检查。
- 大按钮(48px)改变了所有页面的按钮高度:`size="sm"` 的退出/取消按钮仍要 ≥ 44px 且不换行 → Task 2。
- 字体构建期需要联网访问 Google Fonts;失败时不要静默回退 → Task 1 若 `pnpm build` 取不到字体,报告 BLOCKED。

---

### Task 1: 设计令牌与字体

**Files:**
- Modify: `src/app/globals.css`、`src/app/layout.tsx`
- Create: `tests/unit/ui-tokens.test.ts`

**Interfaces:**
- Produces(CSS 变量,在 `:root` 里,值取 Figma 原值,小写十六进制):
  `--background:#f8f7f3`、`--foreground:#202c29`、`--card:#ffffff`、`--card-foreground:#202c29`、`--popover:#ffffff`、`--popover-foreground:#202c29`、`--primary:#245f50`、`--primary-foreground:#ffffff`、`--secondary:#f0f1ec`、`--secondary-foreground:#202c29`、`--muted:#f0f1ec`、`--muted-foreground:#626d67`、`--accent:#e9f0eb`、`--accent-foreground:#245f50`、`--destructive:#a53c34`、`--border:#d9ded7`、`--input:#7d8c83`、`--ring:#245f50`、`--sidebar:#f8f7f3`、`--sidebar-foreground:#202c29`、`--sidebar-primary:#245f50`、`--sidebar-primary-foreground:#ffffff`、`--sidebar-accent:#e9f0eb`、`--sidebar-accent-foreground:#245f50`、`--sidebar-border:#d9ded7`、`--sidebar-ring:#245f50`;新增:`--surface:#ffffff`、`--surface-inverse:#202c29`、`--danger-surface:#fbf0ed`、`--border-danger:#a53c34`、`--text-accent:#245f50`、`--text-disabled:#57635c`、`--on-dark-muted:#dce4dd`、`--primary-hover:#194839`、`--action-disabled:#e2e5df`。
- Produces(`@theme inline`):`--color-surface`、`--color-surface-inverse`、`--color-danger-surface`、`--color-border-danger`、`--color-text-accent`、`--color-text-disabled`、`--color-on-dark-muted`、`--color-primary-hover`、`--color-action-disabled`(各指向同名 `var(--…)`);`--radius-tag:4px`、`--radius-control:6px`、`--radius-notice:8px`、`--radius-card:12px`(使 `rounded-tag/-control/-notice/-card` 可用);`--font-sans:var(--font-inter),ui-sans-serif,system-ui,sans-serif`;`--font-heading:var(--font-lora),ui-serif,Georgia,serif`。
- Produces(`layout.tsx`):`<html>` 带 Inter 与 Lora 的 CSS 变量类名;`<body>` 仍渲染 `{children}`(外壳在 Task 4 加)。

- [ ] **Step 1: 写失败测试 `tests/unit/ui-tokens.test.ts`**
  读取 `src/app/globals.css`(`node:fs`),取出第一个 `:root { … }` 块;对上面"Produces"里的每个 `:root` 变量断言 `--name: value;` 存在(值大小写不敏感);对每个 `@theme inline` 新增项断言存在。再断言 `.dark` 块仍存在(未被删除)。
- [ ] **Step 2: 运行确认失败** — `pnpm exec vitest run tests/unit/ui-tokens.test.ts`,预期 FAIL(令牌还是 oklch 灰度)。
- [ ] **Step 3: 改 `globals.css`** — 只替换 `:root` 块里对应变量的值并新增上述变量;在 `@theme inline` 里新增映射与四个圆角、改两个字体变量(原 `--font-heading: var(--font-sans)` 与 `--font-sans: ui-sans-serif…` 两行);删除 `body { font-family: ui-sans-serif… }` 这条覆盖(让 `html.font-sans` 生效)。`--chart-*`、`--radius`、`.dark` 块不动。
- [ ] **Step 4: 改 `layout.tsx`** — `import { Inter, Lora } from "next/font/google"`;`Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" })`;`Lora({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-lora", display: "swap" })`;`<html lang="en" className={\`${inter.variable} ${lora.variable} font-sans\`}>`。暂时保留现有 `<SiteNav />`。
- [ ] **Step 4b: 构建验证字体** — `pnpm build`,预期成功且无字体下载错误。若因网络取不到字体,**停下并报告 BLOCKED**,不要改成别的字体或吞掉错误。
- [ ] **Step 5: 运行测试** — `pnpm exec vitest run tests/unit/ui-tokens.test.ts` PASS;再跑 `pnpm test`、`pnpm lint`、`pnpm typecheck` 全部通过。
- [ ] **Step 6: 提交** — `git add src/app/globals.css src/app/layout.tsx tests/unit/ui-tokens.test.ts`;`git commit -m "ui: Figma design tokens, Inter and Lora fonts"`。

---

### Task 2: Button 对齐、Badge、Notice、Card

**Files:**
- Modify: `src/components/ui/button.tsx`
- Create: `src/components/ui/badge.tsx`、`src/components/ui/notice.tsx`、`src/components/ui/card.tsx`
- Test: `tests/unit/ui-primitives.test.ts`

**Interfaces:**
- Consumes: Task 1 的令牌与圆角类。
- Produces:
  - `Button`(API 不变:`variant` 同现有集合,`size` 同现有集合,`asChild`)。视觉改为:`default` = `bg-primary text-primary-foreground hover:bg-primary-hover disabled:bg-action-disabled disabled:text-text-disabled`(禁用时不再用 `opacity-50`);`outline` = `border-input bg-card text-foreground hover:bg-secondary`;全部变体圆角 `rounded-control`、字重 `font-semibold`;`size:"default"` = `min-h-12 px-5`;`size:"sm"` = `min-h-11 px-4`(≥ 44px);`xs`/`icon*` 尺寸保持原样。`focus-visible` 环用 `ring-ring`。
  - `Badge({ tone?: "accent" | "neutral", className?, ...span props }): JSX.Element` — `<span>`,`rounded-tag px-[9px] py-[5px] text-[11px] font-medium`;`accent` = `bg-accent text-text-accent`;`neutral` = `bg-secondary text-muted-foreground`。默认 `accent`。
  - `Notice({ intent: "error" | "success" | "progress" | "info", children, className?, ...div props }): JSX.Element` — `<div>`,`rounded-notice`,左侧 lucide 图标(`error`→`CircleAlert`、`success`→`CircleCheck`、`progress`→`LoaderCircle`、`info`→`Info`),图标 `aria-hidden`。默认 `role`:`error`→`"alert"`、`success`/`progress`→`"status"`、`info`→`"note"`;调用方传入的 `role`、`data-testid` 等 props **覆盖默认值**。`error` = `bg-danger-surface border-border-danger text-destructive`;其余 = `bg-accent border-border text-text-accent`(`info` 与 `progress` 视觉相同,`progress` 的图标带 `animate-spin`)。
  - `Card({ className?, ...div props }): JSX.Element` — `bg-card border border-border rounded-card`。

- [ ] **Step 1: 写失败测试 `tests/unit/ui-primitives.test.ts`**(`renderToStaticMarkup(createElement(...))`):
  - `Notice intent="error"` 输出含 `role="alert"`;`intent="success"` 与 `"progress"` 含 `role="status"`;`intent="info"` 含 `role="note"`;传 `role="status"` 给 `info` 时输出 `role="status"` 且不含 `role="note"`;传 `data-testid="x"` 时输出含 `data-testid="x"`;图标带 `aria-hidden="true"`。
  - `Badge` 默认含 `bg-accent`;`tone="neutral"` 含 `bg-secondary`。
  - `Card` 含 `rounded-card`。
  - `Button`:默认输出含 `min-h-12` 与 `rounded-control`;`size="sm"` 含 `min-h-11`;`variant="outline"` 含 `border-input`;`disabled` 输出含 `disabled` 属性。
- [ ] **Step 2: 运行确认失败** — `pnpm exec vitest run tests/unit/ui-primitives.test.ts`,预期 FAIL(文件不存在 / 类名不符)。
- [ ] **Step 3: 实现**上述四个文件/改动;沿用现有 `cva` + `cn` 写法与文件风格(`button.tsx` 用双引号无分号?——以文件现有风格为准,新文件跟 `src/components/job-status.tsx` 的风格)。
- [ ] **Step 4: 运行测试** — 目标文件 PASS;`pnpm test`、`pnpm lint`、`pnpm typecheck` 通过。
- [ ] **Step 5: 提交** — `git add` 上面五个路径;`git commit -m "ui: align Button with the design system; add Badge, Notice and Card"`。

---

### Task 3: SelectField、CheckboxRow、TextAction

**Files:**
- Create: `src/components/ui/select-field.tsx`、`src/components/ui/checkbox-row.tsx`、`src/components/ui/text-action.tsx`
- Test: `tests/unit/ui-controls.test.ts`

**Interfaces:**
- Consumes: Task 1 令牌、`cn` from `@/lib/utils`。
- Produces:
  - `SelectField({ label: string, name: string, options: { value: string; label: string; disabled?: boolean }[], defaultValue?: string, hint?: string, error?: string, id?: string, className?: string }): JSX.Element` — 渲染 `<div>`:`<label htmlFor>` + 原生 `<select name id>`(`min-h-11 rounded-control border border-input bg-card px-3`,`focus-visible:ring-ring`)+ 可选 `hint`(`<p id>`,`text-muted-foreground`)+ 可选 `error`(`<p id>`,`text-destructive`)。`id` 缺省用 `React.useId()`。有 `error` 时 select 带 `aria-invalid="true"` 且 `aria-describedby` 指向 error(与 hint 的 id 用空格拼接);否则有 hint 时指向 hint。
  - `CheckboxRow({ name: string, label: string, value?: string, defaultChecked?: boolean, disabled?: boolean, className?: string }): JSX.Element` — `<label className="min-h-11 …">` **包住**原生 `<input type="checkbox" name value defaultChecked disabled>` 与标签文本(`<span>`)。不用自绘的假 checkbox;用 `accent-primary` 着色。
  - `TextAction(props: ({ href: string } & Omit<ComponentProps<typeof Link>, "href">) | ({ href?: undefined } & ComponentProps<"button">) & { icon?: ReactNode }): JSX.Element` — 有 `href` 时渲染 `next/link` 的 `Link`,否则 `<button type="button">`(调用方的 `type` 可覆盖);共同类名含 `min-h-11 inline-flex items-center gap-1.5 text-[13px] font-semibold text-text-accent hover:underline`;`icon` 渲染在文字前并 `aria-hidden`。

- [ ] **Step 1: 写失败测试 `tests/unit/ui-controls.test.ts`**:
  - `SelectField`:输出含 `<select`、`<label for="…">` 的 `for` 值等于 `<select id>`;选项里 `disabled` 的 `<option>` 带 `disabled`;传 `hint="h"` 时 `aria-describedby` 指向含 "h" 的元素 id;传 `error="e"` 时含 `aria-invalid="true"` 且 `aria-describedby` 包含 error 元素的 id;`defaultValue` 对应 `<option … selected>`。
  - `CheckboxRow`:输出是 `<label …><input type="checkbox" name="documents" value="notes" checked …>` 且 label 文本在同一 `<label>` 内(正则断言 `<label[^>]*>\s*<input[^>]*type="checkbox"[\s\S]*Tutor Lesson Notes[\s\S]*</label>`);`defaultChecked` → `checked`;`disabled` → `disabled`。
  - `TextAction`:带 `href="/x"` 输出 `<a`、`href="/x"`、含 `min-h-11`;无 `href` 输出 `<button`、`type="button"`、含 `min-h-11`;`icon` 内容出现在文字之前且其容器 `aria-hidden="true"`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**三个组件(服务端组件即可,不加 `"use client"`;`useId` 在服务端可用)。
- [ ] **Step 4: 运行测试** — 目标文件 PASS;`pnpm test`、`pnpm lint`、`pnpm typecheck` 通过。
- [ ] **Step 5: 提交** — `git add` 四个路径;`git commit -m "ui: add SelectField, CheckboxRow and TextAction controls"`。

---

### Task 4: 应用外壳(Logo、AppHeader、WorkspaceNav)

**Files:**
- Create: `src/lib/ui/nav.ts`、`src/components/app/logo.tsx`、`src/components/app/app-header.tsx`、`src/components/app/workspace-nav.tsx`
- Modify: `src/app/layout.tsx`
- Delete: `src/components/site-nav.tsx`(`git rm`;确认 `grep -rn "site-nav" src tests` 无残留引用)
- Test: `tests/unit/nav.test.ts`

**Interfaces:**
- Consumes: Task 1–3 的令牌与 `Button`;`getRequestUser()` from `@/lib/server/auth/require-user`(返回 `{ email: string } | null`,以现有 `site-nav.tsx` 的用法为准);`signOut` from `@/app/login/actions`。
- Produces:
  - `NAV_ITEMS: readonly { href: string; label: string; icon: "create" | "materials" | "legacy" }[]`,顺序:`{ "/prepare", "Create material" }`、`{ "/lessons", "My materials" }`、`{ "/lessons/new", "Quick form" }`(标签 "Quick form" 是现有旧表单入口,M7 退役;**Dashboard 项在 U5 加,现在不放死链接**)。`activeNavHref(pathname: string, hrefs: readonly string[]): string | null` 位于 `src/lib/ui/nav.ts`:返回在**路径段边界**上匹配 `pathname` 的**最长** `href`(`/lessons/new` 只匹配 `/lessons/new`,不匹配 `/lessons`;`/lessons/abc` 匹配 `/lessons`;`/lessons` 不匹配 `/lessons-x`),无匹配返回 `null`。
  - `Logo({ className? })`:Figma `49:14289` 的 CSS 画法——26×30 的 `bg-primary` 方块、圆角 3px、内含三条白色 1.5px 横线(宽 14/14/9,间距 4,左内边距 6,上内边距 8)+ 文字 "NotePrep"(`font-heading font-semibold text-2xl text-foreground`),两者间距 9px。方块 `aria-hidden`。
  - `AppHeader({ email }: { email: string })`(服务端):80px 高(`min-h-[72px] md:min-h-20`)、白底 `bg-card`、下边框;左 `Link href="/"` 包 `Logo`;中间 "Your tutor workspace"(`hidden md:block text-sm text-muted-foreground`);右:圆形头像(`bg-accent text-text-accent`,内容为邮箱首字母大写)+ 邮箱(`hidden sm:inline`)+ 退出表单(`<form><Button type="submit" variant="outline" size="sm" formAction={signOut}>Sign out</Button></form>`,**按钮文字仍是 "Sign out"**)。
  - `WorkspaceNav()`(`"use client"`,用 `usePathname()` + `activeNavHref(pathname, NAV_ITEMS.map(i => i.href))`):`<nav aria-label="Main">`;桌面(`md:`)为 208px 侧栏内的竖排列表,移动端为横向一行(`overflow-x-auto` 在导航内部,不造成页面横向滚动);当前项 `aria-current="page"` 且 `bg-sidebar-accent text-sidebar-accent-foreground`;每项 `min-h-11`,lucide 图标(`SquarePen`、`Files`、`FileText`)。
  - `layout.tsx`:根布局 `async`,`const user = await getRequestUser()`;已登录 → `<AppHeader email={user.email}/>` + 桌面 `md:grid md:grid-cols-[208px_1fr]` 的 `<aside className="border-r border-sidebar-border bg-sidebar"><WorkspaceNav/></aside>` + `<div>{children}</div>`;未登录 → 简化顶栏(`Logo` 链到 `/` + 右侧 `Link href="/login"` 文字 "Sign in")+ `{children}`。页面自己的 `<main>` 保持不变;layout 不再输出 `<main>`。`<body className="min-h-screen bg-background">`。

- [ ] **Step 1: 写失败测试 `tests/unit/nav.test.ts`**:`activeNavHref("/lessons/new", [...])` = `/lessons/new`;`"/lessons"` = `/lessons`;`"/lessons/abc-123"` = `/lessons`;`"/lessons-x"` = `null`;`"/prepare"` 与 `"/prepare/x"` = `/prepare`;`"/"` = `null`;空列表 = `null`。另断言 `NAV_ITEMS` 的 href 列表恰为 `["/prepare","/lessons","/lessons/new"]`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现** `nav.ts` 与三个组件,改 `layout.tsx`,`git rm src/components/site-nav.tsx`。
- [ ] **Step 4: 运行** `pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm build` 全部通过。
- [ ] **Step 5: 若 Docker/Supabase 可用**:`pnpm supabase:start` 后 `pnpm test:e2e`,现有 E2E 全部通过(不改断言)。不可用则在报告里写"E2E 未运行"。
- [ ] **Step 6: 提交** — 明确列出新增/修改/删除的路径(`git add` 新文件与 `src/app/layout.tsx`,`git rm` 旧文件);`git commit -m "ui: application shell with header and workspace navigation"`。

---

### Task 5: 现有内联提示换成 Notice(文案与 testid 不变)

**Files:**
- Modify: `src/app/prepare/page.tsx`、`src/app/lessons/new/page.tsx`、`src/app/lessons/[id]/page.tsx`、`src/app/login/page.tsx`
- Test: 不新增断言;靠现有 E2E 与 `tests/unit/ui-primitives.test.ts`(Task 2)

**Interfaces:**
- Consumes: `Notice`(Task 2)。
- Produces: 无新接口。

替换对照(文案、`data-testid`、`role` 语义逐字保留):

| 位置 | 现状 | 改为 |
|---|---|---|
| `prepare/page.tsx` header 的 `params.error` | `<p role="alert" className="mt-4 rounded border border-destructive p-3 text-sm">` | `<Notice intent="error" className="mt-4">`(默认 `role="alert"`) |
| `prepare` 的 `SampleBanner` | `<p role="note" … data-testid="sample-banner">` | `<Notice intent="info" className="mt-4" data-testid="sample-banner">` |
| `prepare` 的 `bad-selection`、`unsupported-topic` | `<p role="alert" … data-testid=…>`(内含 "Start again"/"Back to the topics" 链接) | `<Notice intent="error" className="mt-4" data-testid=…>`,内部链接不变 |
| `prepare` 与 `lessons/new` 的额度用完 | `<p role="status" className="mt-4 rounded border p-3 text-sm">` | `<Notice intent="info" role="status" className="mt-4">`(**必须显式 `role="status"`**,E2E `getByRole("status")` 依赖它) |
| `lessons/new` 的 `error` | `<p role="alert" …>` | `<Notice intent="error" className="mt-4">` |
| `lessons/[id]/page.tsx` 的 `review-reminder` | `<p className="mt-3 rounded border p-3 text-sm" data-testid="review-reminder">` | `<Notice intent="info" className="mt-3" data-testid="review-reminder">` |
| `login/page.tsx` 的 `message` | `<p role="status" className="mt-4 text-sm">` | `<Notice intent="info" role="status" className="mt-4">`(登录页同一时刻只有一个 status) |

- [ ] **Step 1: 基线** — 在改动前确认 `pnpm test`、`pnpm lint`、`pnpm typecheck` 通过(记录输出)。
- [ ] **Step 2: 按上表逐处替换**;不改任何文案、`data-testid`、链接、Server Action。每个页面改完后确认没有留下未使用的 import。
- [ ] **Step 3: 运行** `pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm build` 全部通过。
- [ ] **Step 4: 若 Docker/Supabase 可用**:`pnpm test:e2e` 全部通过;不可用则在报告里写"E2E 未运行"。
- [ ] **Step 5: 视觉检查(尽力而为)**:能启动应用时,用 Playwright 在 1440px 与 390px 截图 `/prepare`、`/jobs/<id>`、`/lessons/<id>`、`/lessons`,确认外壳、令牌、字体生效、无横向滚动;截图放在 `/tmp` 下的临时目录,**不提交**。不能运行则如实说明。
- [ ] **Step 6: 提交** — `git add` 上面四个页面路径;`git commit -m "ui: use Notice for inline messages without changing copy or test ids"`。

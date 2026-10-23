# 测试指南(动手版,截至 M5)

本文告诉你**怎么跑测试、怎么在应用里手动验证、每项测试能证明什么、哪些还没验证**。测试策略与证据层级见 [test-plan.md](./test-plan.md);本文只讲操作。所有数据均为虚构/样例数据。

## 1. 前置条件

| 需要 | 用于 |
| --- | --- |
| Node 24.13.1、pnpm 10.33(`pnpm install`) | 全部 |
| Docker | 本地 Postgres(`pnpm db:up`)、LaTeX 沙箱镜像、Supabase 本地栈 |
| Supabase CLI(`pnpm supabase:start`) | Supabase 边界测试、E2E、本地登录 |
| `.env`(从 `.env.example` 复制) | 手动测试、worker |

## 2. 自动化测试(按顺序,从快到慢)

| 命令 | 内容 | 需要 |
| --- | --- | --- |
| `pnpm lint` | ESLint(含禁用 `process.env` 的规则) | — |
| `pnpm typecheck` | `next typegen` + `tsc --noEmit` | — |
| `pnpm test` | 单元测试(约 424 个):课包、文字规则、LLM 适配器、渲染、沙箱参数、清单 v2、表单 | — |
| `pnpm test:integration` | 真实 Postgres:额度并发、幂等、课程、请求 v2、结算、旧路径;**草稿**(`tests/integration/drafts.test.ts`:免费、幂等、限流、过期清理、跨用户)与草稿表的触发器/授权(`schema.test.ts`) | `pnpm db:up` |
| `pnpm test:supabase` | 登录、Storage(私有桶、签名 URL、仅 PDF)、RLS、Data API 边界(26 个) | `pnpm supabase:start`(Storage 已在 `config.toml` 启用;改配置后需 stop 再 start) |
| `pnpm test:latex` | **真实容器**(40 个):OS 隔离、恶意 TeX、完整链路、可复现性 | `pnpm latex:image` |
| `pnpm test:e2e` | Playwright 关键流程(含预览/下载);`E2E_COMPILER=docker` 用真实 PDF 跑。`draft-flow.spec.ts` 跑在第二个 project(`chromium-draft`),它连接另一个以 `FLOW_MODE=draft` 启动的服务器(端口 3101);其余 spec 仍连默认的 `legacy` 服务器(3100);`export-flow.spec.ts` 跑在 `chromium-export`,连接第三个以 `FLOW_MODE=draft EXPORT_ENABLED=1` 启动的服务器(3102) | 本地 Supabase;**先停掉自己的 `pnpm worker:dev`** |
| `pnpm build` | 生产构建 | — |
| `pnpm curriculum:validate` | 样例数据集校验 | — |

注意:
- 本地 E2E 与你正在运行的 worker 共用同一个数据库,会互相抢任务。要么停 worker,要么靠 PR 让 CI 在干净机器上跑(CI 的 5 个 job:static、integration、supabase、e2e、latex-sandbox)。
- 集成测试共用一个库,个别测试会故意损坏数据;全局漂移检查已限定到各自的 owner。

## 3. 在应用里手动验证(端到端)

1. 启动:`pnpm db:up`,`pnpm supabase:start`,`pnpm dev`(绑定 127.0.0.1,WSL2 下务必用 `http://127.0.0.1:3000`)。
2. 迁移与样例数据:`pnpm db:migrate:deploy`,然后 `pnpm curriculum:load`(仅样例数据集,开发/staging)。
3. 注册:打开 `/`,用任意虚构邮箱注册。本地验证邮件在 Supabase 的 Mailpit(`pnpm supabase:status` 里的 Inbucket/Mailpit 地址)里点确认链接。
4. 选择:`/prepare` → 课程 → 级别 → 科目 → 主题 → 时长/难度/输出包 → 生成。选项必须是级联的,不支持的主题应被拒绝。
5. 启动 worker(另一终端):`pnpm worker:dev`。**改过代码后要重启 worker。**
6. 三种模式(在 `.env` 设置后**重启 worker**):

   | 目的 | 设置 |
   | --- | --- |
   | 无费用、确定性文字 | `LESSON_PROSE=template`,`COMPILER=skeleton` |
   | 真实 PDF 编译(无模型) | `COMPILER=docker`,`LESSON_PROSE=template`,先 `pnpm latex:image`;**要在页面里预览还需** `OBJECT_STORE=supabase`、`SUPABASE_URL`、`SUPABASE_SECRET_KEY`(见 README M5) |
   | 真实模型写文字 | `LESSON_PROSE=llm` + `LLM_*`(会产生费用) |

7. 看结果:任务页依次显示排队 → 生成 → 验证 → 编译 → 保存 → 完成,**完成后自动跳转到 `/lessons/[id]` 预览页**(标签页切换三份文档、新标签页打开、下载 PDF、课程信息面板)。预览要求 worker 用 `OBJECT_STORE=supabase`;用默认的 `fs` 时页面能打开但文件取不到(会显示"暂时无法提供")。
8. 额度:成功后"剩余生成次数"减 1;失败后不扣("This did not use one of your generations");第 4 次应被拒绝。同一幂等键重复提交只产生一个任务。

### 草稿流程(`FLOW_MODE=draft`,免费预览)

在 `.env` 设置 `FLOW_MODE=draft` 并重启 Web:`/prepare` 的按钮变为 "Create draft preview",提交后进入 `/drafts/[id]`(HTML 预览、三个文档标签页、"Draft expires …"、禁用的 "Export is coming next")。不预留额度、不入队、不需要 worker;"剩余生成次数"不变。默认(`legacy` 或不设置)行为与之前完全相同。所有阈值见 `src/lib/server/limits.ts`(环境变量,例如 `DRAFT_TTL_DAYS`);worker 的清扫循环会把过期草稿标记为 expired,宽限期(`DRAFT_PURGE_GRACE_DAYS`)后删除。

## 4. 失败时看哪里

- 任务页上的文字是给用户看的,已脱敏。技术原因看 **worker 终端日志**(带 job id、阶段、错误类型,不含课程正文)。
- README 的 "why a job failed" 一节列出常见原因。
- `COMPILER=docker` 失败常见原因:镜像不存在(`pnpm latex:image`)、Docker 守护进程不可达、超时。
- 已知缺口:`CompileError.detail` 目前**没有**写入任务记录。

## 5. 检查生成的 PDF

- 页面:`/lessons/[id]` 直接预览/下载(`.tex` 不对用户提供)。
- 数据库:最新 `LessonRevision` 的 manifest v2(每个文档的 `pdf.path / sha256 / bytes / pages`)。
- Storage:桶 `lesson-artifacts`,路径 `{owner}/{lesson}/{revision}/{attempt}/{doc}.{pdf|tex}`;本地没有启用 Studio,用页面下载,或用 `OBJECT_STORE=fs` 时在 `.data/objects` 下查看。
- 人工检查清单:三份文档是否齐全(按所选输出包);**Worksheet 不含任何答案**;Solutions 与 Notes 里的题号/答案一致;页边距、分页(每道题的作答线与题目同页)、公式不溢出;页脚/提示语提醒教师先审阅。

## 6. 真实模型评估(单独、受控、会花钱)

`pnpm eval:prose`(需要 `LLM_*`)。最近一次(Haiku 5.5):12 次中首次通过 11、最终 12/12,约 7.4k micro-units/次,中位延迟约 9 秒。价格配置未核对服务商价目表。不要在 PR 里跑。

## 7. 这些测试**不能**证明什么

- 沙箱是 runc + Docker 默认 seccomp,**不是 gVisor**;生产主机未验证(D-03、D-20、D-44)。上线前必须在目标主机重跑 `pnpm test:latex`。
- 没有教师/人工审阅模型写的文字;没有版面视觉回归;移动端 PDF 内嵌没有真机测试;CDN/框架缓存键没有在部署环境检查;下载的频率限制尚未接入。
- Staging 没有 worker 主机,任务会一直排队;staging 尚未加载样例数据。
- Stripe 订阅矩阵、孤儿对象清理、备份恢复演练尚未覆盖(Phase 3/4)。
- 假流程通过 ≠ 可以上线(CLAUDE.md §11)。

## 8. 变异检查(可选,用于怀疑测试是否真的有效)

做法:临时改坏一行实现(例如去掉沙箱的 `--network none`、放宽幂等检查),确认对应测试**变红**,再还原。M1–M4 各层都做过(共约 60 次),存活的变异体均已分析为等价或补了测试。不要提交变异。

## 8b. Export suites (S4b, English)
- Unit (`pnpm test`): `export-confirm-ui`, `export-confirm-action`, `export-cancel-action`, `export-view`, `export-status-view`, `export-poller`, `export-page`, `export-status-route`, `job-page-export-redirect`, `export-errors`, `export-spec`, `export-verify`.
- Integration (`pnpm test:integration`, real Postgres): `export-confirm` (including the 10-parallel same-key proof), `export-worker` (`runExport`), `export-cancel`, `export-settlement`, `export-locking`, `export-security`.
- Real compiler (`pnpm test:latex`): `tests/latex/export-pipeline.test.ts`.
- E2E (`pnpm test:e2e`): `tests/e2e/export-flow.spec.ts` on the third server (3102): full flow with free re-export, double submit, failed export releases, stale tab, cancel while queued, isolation, flag off. `E2E_COMPILER=docker` asserts real `%PDF-` bytes in the full-flow case.

## 9. 清理

`pnpm db:down`,`pnpm supabase:stop`。残留容器:`docker ps -a --filter name=noteprep-tex-`,可用 `docker rm -f` 清除。

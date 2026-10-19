# 测试指南(动手版,截至 M4)

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
| `pnpm test:integration` | 真实 Postgres(约 162 个):额度并发、幂等、课程、请求 v2、结算、旧路径 | `pnpm db:up` |
| `pnpm test:supabase` | 登录、Storage、RLS、Data API 边界(15 个) | `pnpm supabase:start` |
| `pnpm test:latex` | **真实容器**(40 个):OS 隔离、恶意 TeX、完整链路、可复现性 | `pnpm latex:image` |
| `pnpm test:e2e` | Playwright 关键流程 | 本地 Supabase;**先停掉自己的 `pnpm worker:dev`** |
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
   | 真实 PDF 编译(无模型) | `COMPILER=docker`,`LESSON_PROSE=template`,先 `pnpm latex:image` |
   | 真实模型写文字 | `LESSON_PROSE=llm` + `LLM_*`(会产生费用) |

7. 看结果:任务页应依次显示排队 → 生成 → 验证 → 编译 → 保存 → 完成。**M5 之前没有预览/下载界面**,PDF 只在 Storage 和数据库里(见 §5)。
8. 额度:成功后"剩余生成次数"减 1;失败后不扣("This did not use one of your generations");第 4 次应被拒绝。同一幂等键重复提交只产生一个任务。

## 4. 失败时看哪里

- 任务页上的文字是给用户看的,已脱敏。技术原因看 **worker 终端日志**(带 job id、阶段、错误类型,不含课程正文)。
- README 的 "why a job failed" 一节列出常见原因。
- `COMPILER=docker` 失败常见原因:镜像不存在(`pnpm latex:image`)、Docker 守护进程不可达、超时。
- 已知缺口:`CompileError.detail` 目前**没有**写入任务记录。

## 5. 检查生成的 PDF(M5 之前)

- 数据库:最新 `LessonRevision` 的 manifest v2(每个文档的 `pdf.path / sha256 / bytes / pages`)。
- Storage:路径 `{owner}/{lesson}/{revision}/{attempt}/{doc}.{pdf|tex}`;用 Supabase Studio 下载 PDF 后人工打开。
- 人工检查清单:三份文档是否齐全(按所选输出包);**Worksheet 不含任何答案**;Solutions 与 Notes 里的题号/答案一致;页边距、分页(每道题的作答线与题目同页)、公式不溢出;页脚/提示语提醒教师先审阅。

## 6. 真实模型评估(单独、受控、会花钱)

`pnpm eval:prose`(需要 `LLM_*`)。最近一次(Haiku 5.5):12 次中首次通过 11、最终 12/12,约 7.4k micro-units/次,中位延迟约 9 秒。价格配置未核对服务商价目表。不要在 PR 里跑。

## 7. 这些测试**不能**证明什么

- 沙箱是 runc + Docker 默认 seccomp,**不是 gVisor**;生产主机未验证(D-03、D-20、D-44)。上线前必须在目标主机重跑 `pnpm test:latex`。
- 没有教师/人工审阅模型写的文字;没有版面视觉回归。
- Staging 没有 worker 主机,任务会一直排队;staging 尚未加载样例数据。
- Stripe 订阅矩阵、孤儿对象清理、备份恢复演练尚未覆盖(Phase 3/4)。
- 假流程通过 ≠ 可以上线(CLAUDE.md §11)。

## 8. 变异检查(可选,用于怀疑测试是否真的有效)

做法:临时改坏一行实现(例如去掉沙箱的 `--network none`、放宽幂等检查),确认对应测试**变红**,再还原。M1–M4 各层都做过(共约 60 次),存活的变异体均已分析为等价或补了测试。不要提交变异。

## 9. 清理

`pnpm db:down`,`pnpm supabase:stop`。残留容器:`docker ps -a --filter name=noteprep-tex-`,可用 `docker rm -f` 清除。

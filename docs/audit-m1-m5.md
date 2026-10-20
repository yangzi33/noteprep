# M1–M5 审计报告

> 日期 2026-10-19/20;基线提交 `fa66973`;分支 `fix/audit-m1-m5`(13 个修复提交,未推送、未合并)。
> 本文只陈述有证据的内容。**不是上线就绪声明**:沙箱主机、托管 Supabase、真实模型质量、staging 均未验证(见第 6 节)。

## 1. 范围与方法

| 项 | 内容 |
|---|---|
| 范围 | M1–M5(课程域、选择向导与请求 v2、课包与 LLM 文字、渲染与沙箱编译、预览与导出)。**不含 M6**。 |
| 基线 | `fa66973`:lint/typecheck 通过;单元 432、集成 168、supabase 26、latex 40;数据集校验通过(e2e 14 在 M5 合并时通过,CI 绿)。 |
| 独立评审 | 五份只读评估报告(M1、M2、M3a/b、M4、M5),评估者为 Sonnet 或 Opus 档;评估者不运行数据库套件,容器行为多数来自读代码。 |
| 修复 | 任务 T1–T8(顺序执行的实现者,Sonnet 档)。每个任务有独立任务评审(SPEC/QUALITY);有问题的任务做范围内再评审。最多使用 1 轮修复 + 1 次再评审(T2、T4、T7、T8);T8 再评审后仍留 R8-06(已搁置,见第 2、6 节)。T3、T5、T6 评审一次通过。 |
| 最终 | 全分支最终评审:**待完成**(见第 6 节)。最终验证命令见第 5 节。 |

## 2. 审计发现与处理

状态:已修复(提交)/ 已记录为已知限制 / 未修复-延期 / 不是缺陷。

### 2.1 五份评估报告的发现

| ID | 级别 | 标题 | 状态 |
|---|---|---|---|
| M1-01 | Medium | 校验器接受数据库会拒绝的数据(空 kind、序号范围、日期) | 已修复(0c89329) |
| M1-02 | Medium | real 数据集来源只查存在不查内容 | 已修复(0c89329);仅 TS 校验,数据库 CHECK 未加 |
| M1-03 | Low | 若干自由文本字段无长度上限 | 已修复(0c89329);仅 TS 校验,数据库 CHECK 未加 |
| M1-04 | Low | ID 格式允许点段(`..`、`//`) | 已修复(0c89329) |
| M1-05 | Low | "生产加载器拒绝示例数据"只是调用方标志 | 已修复(93aa1a7、586d508:`CURRICULUM_TARGET_ENV`,`--allow-sample` 必须显式非生产) |
| M1-06 | Low | 并发加载检查后创建竞态 | 已修复(93aa1a7:按课程的 advisory lock,含 2 个并发集成测试) |
| M1-07 | Low | 缺稳定 ID 黄金清单测试 | 已修复(0c89329,黄金清单)。"示例数据不渲染对齐声明"在 M3/M5 层另有测试(见第 3 节) |
| M1-08 | Low | 每次调用读取整版本课程树 | 未修复-延期(示例数据集规模无影响;真实数据集 CM 时再评估;无测量) |
| M1-09 | Low | 所有者角色可 TRUNCATE/直接插入 published 行、concept 表无不可变触发器 | 未修复-延期(仅所有者/迁移角色可达;运行时角色已有测试禁止) |
| M2-01 | Medium | v2 上下文解析在事务外占用共享连接池,并发时池饥饿 | 已修复(482655e:解析在入队事务连接上进行;复现测试 pool max 3 × 12 并发,修复前事务超时,修复后通过) |
| M2-02 | Medium | IP 限流在两条入队路径均未调用 | 未修复-延期(Phase 1 起已有,README 计划为 P3-T2;裁定:账号限流与并发限制仍生效;代价:同一 IP 多账号可各用 3 次免费额度) |
| M2-03 | Low | 缺 v1/v2 幂等冲突测试 | 已修复(482655e,仅补测试,行为本就正确) |
| M2-04 | Low | `documents` 顺序、`objectiveIds` 重复影响请求哈希 | 已修复(482655e:规范化排序,重复拒绝) |
| M2-05 | Low | v1 快速表单在 docker 编译配置下必失败 | 未修复-延期(不扣额度;D-37 规定 M3a 验收后隐藏入口,M7 删除) |
| M2-06 | Low | v2 路径缺额度不变量测试 | 已修复(482655e:3 次成功 + 第 4 次拒绝、最后一个额度 12 并发、同 key ×8) |
| M3-01 | Medium | 校验器不核对对齐块的课程身份 | 已修复(b30ee05) |
| M3-02 | Medium | inputsHash、依赖边从不校验 | 已修复(b30ee05) |
| M3-03 | Medium | 必需节与非空题集不强制 | 已修复(b30ee05) |
| M3-04 | Medium | 上下文畸形时校验器抛异常 | 已修复(b30ee05:报告 CONTEXT_INVALID/REQUEST_INVALID/VALIDATOR_ERROR) |
| M3-05 | Medium | 文字规则放过裸域名、数字词、越狱措辞、年级 | 已修复(ee81537、898e760);残留已知限制:"eight divided by two"类词形计算、"dot xyz"口语形式、无 Unicode 混淆字符折叠 |
| M3-06 | Medium | 无 usage 的调用不计入作业预算 | 已修复(dd66f80:按保守上限计费) |
| M3-07 | Low | `maxCostMicros` 被接受但不在调用前强制 | 未修复-延期(预算为事后计费,单次调用可超出;代价:一次调用的超支) |
| M3-08 | Low | `max_tokens` 截断以相同限制重试 | 已修复(dd66f80:截断直接回退到模板) |
| M3-09 | Low | 取消时 AbortError 外泄 | 不是缺陷(runner 已处理;dd66f80 仅补回归测试 `tests/unit/prose-cancel.test.ts`) |
| M3-10 | Low | 数学 schema 宽松 | 已修复(b30ee05:strictObject) |
| M4-01 | Medium | 宿主 PDF 主动内容扫描易绕过 | 已修复(0470a8f 分词扫描;3efcde0 线性分词器,见 R8-01/02);R8-06 见下 |
| M4-02 | Low | `assertTexIsSafe` 自身缺口(`\\%`、verbatim、worksheet 内 answerline) | 未修复-延期(渲染器今天不产生这些串;纵深防御) |
| M4-03 | Low | 转义器放过 T1 未定义的拉丁字母 | 已修复(0470a8f:在真实镜像里编译确认,U+0126/0127/0138/013F/0140/0149/0166/0167/017F 确会失败,现映射为 `?`)——**评估者的怀疑属实** |
| M4-04 | Low | worksheet PDF 测试断言弱于注释 | 部分修复(0470a8f 仅更正注释;PDF 级答案缺席与 `pdffonts` 检查未加) |
| M4-05 | Low | 页数取自容器自述 | 已修复(0470a8f:宿主数 `/Type /Page` 并要求相等且 ≤ 40) |
| M4-06 | Low | 结算信任 worker 自述的请求文档集合 | 已修复(0470a8f:在提交事务内读取存储的请求) |
| M4-07 | Low | 确定性失败被当作可重试,每次重试重复模型调用 | 已修复(0470a8f:渲染错误、编译错误(除 sandbox_unavailable)为最终失败) |
| M4-08 | Low | 终止先于容器创建时容器可能残留 | 未修复-延期(受 compile.sh 自身限制约束,最长约 96 s;代价:有限的未计量算力) |
| M4-09 | Low | 非生产下占位 PDF 可结算为完整生成 | 未修复-延期(仅 `NODE_ENV=production` 守卫;若 staging worker 未设 production 则违反 CLAUDE.md §8,需在 staging 配置中确保) |
| M4-10 | Low | 镜像不可复现重建;超时设置可能互相矛盾;CI 注释过时 | 未修复-延期(锁文件仅检测漂移;生产用 digest 固定) |
| M5-01 | Medium | 孤儿/被取代对象从不清理,文档称 sweeper 会清 | 部分修复(5c19588:失败/被拒/取消的尝试清理自己的前缀,文档更正)。**上传后崩溃留下的孤儿仍无对账实现**,属 P3,已记录为已知限制 |
| M5-02 | Medium | Storage RLS 不反映删除/发布状态 | 已记录为已知限制(5c19588 文档与 D-48 更正措辞:RLS 只查所有者前缀 + `.pdf`,删除/发布由路由强制;裁定:当前无删除功能,限于所有者自己的数据;**删除功能上线前必须修**) |
| M5-03 | Medium | 私有 PDF 以 `cacheControl: 3600` 存储 | 已修复(5c19588:`max-age=0`;本地实测修复前认证路由返回 3600)。托管 Supabase 的签名路由头未观察;旧对象保持 3600 |
| M5-04 | Low | 文件路由不检查账号状态 | 已修复(5c19588,E2E 覆盖) |
| M5-05 | Low | real + `claim:none` 的对齐提示措辞错误 | 已修复(5c19588,4 个精确文本测试) |
| M5-06 | Low | 作业页成功态显示过时占位文字 | 已修复(5c19588,4fa31f4) |
| M5-07 | Low | README 自相矛盾 | 已修复(5c19588、4fa31f4) |
| M5-08 | Low | 签名失败无日志 | 已修复(5c19588:`artifact_sign_failed` 结构化日志,不含路径/URL) |
| M5-09 | Low | 托管 Supabase 上存储迁移是否适用 | 未修复-延期(UNVERIFIED,需 staging 演练) |

### 2.2 评审轮次中新发现

| ID | 级别 | 标题 | 状态 |
|---|---|---|---|
| T2 评审 | Medium | `CURRICULUM_TARGET_ENV` 未设时默认 development(fail-open) | 已修复(586d508:`--allow-sample` 必须显式设置非生产值) |
| T4 评审 ×3 | Medium | 数字词误报、空白绕过 developer mode、TLD 清单不全 | 已修复(898e760;再评审 ADDRESSED) |
| R8-01 | High | PDF 检查器 `/Length` 伪造可隐藏字典 | 已修复(3efcde0:线性分词器,六种伪造向量均拒绝;再评审 ADDRESSED) |
| R8-02 | Medium | 长度正则二次复杂度(5 MB 输入使 worker 事件循环卡死) | 已修复(3efcde0;最坏输入 5 MB 约 0.3 s,评估者实测) |
| R8-03 | Low | v1 课包仍信任调用方的文档列表(可接受 v2 清单) | 未修复-延期 |
| R8-04 | Low | 编译超时/容器被杀现为最终失败 | 未修复-延期(设计取舍,额度已释放;写入运维手册) |
| R8-05 | Low | 宿主页数可能少计(无 `/Type` 的叶子页) | 未修复-延期(5 MB 上限仍生效) |
| R8-06 | Medium | 查看器按 xref 偏移跳转,检查器不校验偏移落点 | 已搁置,已记录为已知限制(裁定见第 6 节) |
| Q-1 | Medium | 作业页"打开预览"链接在无预览时 404 | 已修复(4fa31f4:`hasPreview` 标志) |
| Q-2 | Low | "清理不掩盖原始失败"测试无法检测掩盖 | 已修复(4fa31f4) |
| Q-3 | Low | 上传阶段的未分类错误跳过清理 | 未修复-延期(保守:从不删除已发布数据;Fs 仅开发/测试) |
| Q-4/Q-5 | Low | README 状态行、缓存措辞偏强 | 已修复(4fa31f4) |
| N-1 | Low | 成功后 `router.refresh()` 一次性,失败无兜底 | 未修复-延期(需手动刷新) |
| e2e 回归 | — | `--allow-sample` 新规则使 e2e 全局设置失败(需导出 `CURRICULUM_TARGET_ENV`) | 已修复(5d91f5e) |
| T1/T3/T5/T6 评审 | Low/Info | 其余低级别备注(如 ISO 日期允许无时区、`course.code` 仍用标题上限、预算对 400/401 也按上限计费) | 未修复-延期,不影响结论 |

## 3. 需求—测试覆盖矩阵

出发点是各评估报告末尾的矩阵;只在能从仓库核实新测试时才更新,否则保留评估者的结论。`PASS`/`PARTIAL`/`UNVERIFIED`/`FAIL`。本节的测试通过情况以第 5 节为准。

### M1

| 验收项 | 实现 | 测试 | 结论 |
|---|---|---|---|
| 迁移、触发器、RLS、授权 | `prisma/migrations/*curriculum*` | `tests/integration/curriculum.test.ts` | PASS |
| 加载器幂等、原子;并发安全 | `src/lib/server/curriculum/load.ts` | 同上("concurrent loads" 2 例,T2 报告称去掉锁则失败) | PASS |
| 已发布版本不可变 | 触发器 | `curriculum.test.ts` | PASS |
| 引用与来源完整性 | `validate-dataset.ts` | `tests/unit/curriculum-dataset.test.ts`(含 T1 新增 30 例) | PASS(仅 TS 层;数据库 CHECK 不对等,见 M1-02/03) |
| 运行时角色只读 | 迁移授权 | `curriculum.test.ts` | PASS |
| `supported` 与注册表一致 | `capabilities.ts`、DAL | 单元 + 集成 | PASS |
| 示例/合成数据在生产被拒 | `load.ts` `resolveLoadTarget`、工作流、DAL | 单元 "loader target environment"、集成 KIND_NOT_ALLOWED | PASS(脚本退出码与工作流本身未端到端执行) |
| 示例数据不渲染对齐声明 | `build.ts`、`lesson-view.ts` | `package.test.ts`(claim none)、`lesson-view.test.ts` | PASS(课包与提示层;真实数据集 CM 后需重验) |
| 长度上限、稳定 ID 黄金清单 | `dataset-schema.ts` | `curriculum-dataset.test.ts`("stable id golden lists") | PASS |
| 合成数据集(含无级别) | `tests/fixtures/curricula` | 单元 + 集成 | PASS |
| CI 数据集校验 | `ci.yml`、`scripts/curriculum-validate.ts` | `pnpm curriculum:validate`(第 5 节) | PASS(脚本本身无专门测试) |

### M2

| 验收项 | 实现 | 测试 | 结论 |
|---|---|---|---|
| `/prepare` URL 驱动、服务端渲染 | `src/app/prepare` | `tests/e2e/prepare.spec.ts` | PASS |
| 只显示所选体系的选项;灰显与服务端拒绝 | `dal/curriculum.ts`、`generation.ts` | `curriculum.test.ts`、`lesson-request-v2.test.ts`、e2e | PASS |
| 更改上一步清空后续 | `prepare-url.ts` | `prepare-request.test.ts`;无点面包屑的 e2e | PARTIAL |
| 无级别体系跳过级别步骤 | `dal/curriculum.ts`、页面 | 仅 DAL 集成 | PARTIAL |
| `LessonRequestV2` 校验、规范化 | `lesson-request.ts` | `prepare-request.test.ts`(含新增规范化/重复拒绝) | PASS |
| 上下文在同一事务内解析 | `generation.ts` | `lesson-request-v2.test.ts`(池压力复现测试) | PASS(修复前为 PARTIAL) |
| v2 与 v1 幂等/额度一致 | `generation.ts` | `allowance.test.ts` + v2 新增(3+1、竞态、同 key ×8、跨版本冲突) | PASS |
| 迁移 B | `20261019092400` | `lesson-request-v2.test.ts` | PASS |
| 刷新/后退保持选择、旧表单 | URL 状态 | e2e | PASS(M2-05:docker 配置下 v1 必失败,延期) |
| 账号/IP 限流 | `generation.ts` | 仅账号限流有测试 | FAIL(IP,M2-02 延期) |

### M3a / M3b

| 验收项 | 实现 | 测试 | 结论 |
|---|---|---|---|
| `lesson-package/1` schema、确定性、提纲 | `package/schema.ts`、`build.ts` | `package.test.ts` | PASS |
| 逐节哈希与依赖 | `hash.ts`、`build.ts` | `package.test.ts`(含 T3 新增篡改用例) | PASS(修复前 PARTIAL) |
| worksheet 类型无答案 | `views.ts` | `package.test.ts` | PASS |
| 整课校验 | `validate.ts` | `package.test.ts`(对齐篡改 10 字段、inputsHash、边、必需节、畸形上下文) | PASS(修复前 PARTIAL) |
| 数学 schema 严格 | `math/schema.ts` | `math.test.ts` | PASS |
| 上下文到达生成引擎 | `build.ts`、`pipeline.ts` | `package.test.ts`、`prose.test.ts` | PASS |
| v2 作业端到端成功 | `worker/pipeline.ts` | `lesson-request-v2.test.ts`(数据库);latex 套件 | PASS(第 5 节已运行) |
| LLM 接口、适配器、假实现 | `src/lib/llm` | `llm-providers.test.ts` | PASS(契约测试对真实适配器仅用 mock HTTP) |
| 文字规则与对抗用例 | `prose-rules.ts` | `prose.test.ts` | PARTIAL(残留限制见 2.1 M3-05) |
| 有界修复与模板回退 | `prose-generate.ts` | `prose.test.ts` | PASS |
| 预算/超时/重试分类 | `jobs.chargeUsage`、`anthropic.ts` | `llm-providers.test.ts`(无 usage 计费、截断)、`prose-cancel.test.ts` | PARTIAL(M3-07 调用前成本检查未做) |
| 受控真实评估 | `scripts/eval-prose.ts`、D-42 | 一次记录(12 次运行) | UNVERIFIED(无教师审阅;超出这一次记录的真实模型质量未验证;人工抽查缺) |

### M4

| 验收项 | 实现 | 测试 | 结论 |
|---|---|---|---|
| `renderPackage` 纯函数、3 模板 | `render.ts`、`templates.ts` | `latex-render.test.ts` | PASS |
| 转义与受限数学渲染 | `escape.ts`、`math.ts` | `latex-render.test.ts`、`tests/latex/escape-chars.test.ts`(新增,真实镜像) | PASS(`assertTexIsSafe` 缺口见 M4-02) |
| 沙箱 runner 与镜像 | `sandbox.ts`、`docker/latex` | `latex-sandbox.test.ts`、`tests/latex/image.test.ts` | PARTIAL(镜像不可复现重建;gVisor/生产主机 UNVERIFIED) |
| 真实编译、三份有效 PDF | `docker-compiler.ts` | `tests/latex/compile.test.ts`、`pipeline.test.ts`(第 5 节:42 通过) | PASS(本机 Docker) |
| worksheet PDF 无答案 | `views.ts`、`render.ts` | 源码级 `latex-render.test.ts`;PDF 级仅措辞 | PARTIAL |
| 同一修订两次渲染一致 | `render.ts` | `latex-render.test.ts`、`compile.test.ts` | PASS |
| 沙箱负面测试 | `sandbox.ts`、`compile.sh` | `tests/latex/sandbox-negative.test.ts` | PARTIAL(缺 UDP、编译级模糊、字体嵌入) |
| 宿主不信任容器输出(tar、PDF、页数) | `tar.ts`、`docker-compiler.ts` | `latex-sandbox.test.ts`(六种伪造向量、5 MB 计时、页数不一致) | PARTIAL(R8-06 xref 偏移未校验,已搁置) |
| 失败路径释放额度 | `pipeline.ts`、`runner.ts` | `tests/latex/pipeline.test.ts`、集成 | PASS |
| 清单 v2 与结算完整性 | `manifest.ts`、`settlement.ts` | `manifest-v2.test.ts`、`lesson-request-v2.test.ts`(新增:存储的请求、v1 清单、模板不符) | PASS(修复前 PARTIAL) |
| 骨架编译器生产禁用 | `worker/env.ts` | `worker-env.test.ts`(生产禁用) | PARTIAL(非生产结算守卫缺,M4-09) |
| 容器不继承凭据 | `env.ts`、`sandbox.ts` | `latex-sandbox.test.ts`、`sandbox-negative.test.ts` | PASS |
| gVisor / 目标生产主机 | — | 无 | UNVERIFIED |

### M5

| 验收项 | 实现 | 测试 | 结论 |
|---|---|---|---|
| 课包页、标签页预览、下载 | `src/app/lessons/[id]` | `tests/e2e/lesson-preview.spec.ts` | PASS(桌面浏览器) |
| Supabase Storage 适配器、私有桶 | `supabase-store.ts`、迁移 | `tests/supabase/storage.test.ts` | PASS(本地栈);托管迁移 UNVERIFIED |
| 短时签名 URL、到期失效 | `route.ts` | storage 测试 | PASS |
| 仅所有者、跨用户拒绝 | DAL + RLS | 集成攻击矩阵、e2e、storage | PASS |
| 账号状态检查 | `route.ts` | e2e(`deleting` → 404) | PASS(修复前缺) |
| 预览与下载同一 revisionId | `rev` 参数 | e2e | PASS |
| 仅 PDF | DAL、策略 | storage、e2e | PASS |
| 对齐信息面板 | `lesson-view.ts` | `lesson-view.test.ts`(精确文本) | PASS(修复前 PARTIAL) |
| `/jobs/[id]` 成功后跳转 | `jobs/[id]/page.tsx`、`job-status.tsx` | e2e、`lesson-view.test.ts` | PASS(N-1 兜底缺;legacy 路径的轮询到刷新未在真实浏览器验证) |
| 缓存头 | `route.ts`、`supabase-store.ts` | e2e(302 `no-store`)、storage(对象无正 max-age) | PARTIAL(本地签名路由无头,托管/CDN 缓存键 UNVERIFIED) |
| 失败尝试清理 | `pipeline.ts` | 集成(提交被拒、取消、清理失败) | PARTIAL(崩溃后孤儿无测试无实现,P3) |
| 删除/发布状态由 RLS 强制 | — | 无 | FAIL(已记录为已知限制,M5-02) |
| 移动端 PDF 内嵌 | 降级链接 | 仅链接 href | UNVERIFIED |
| 托管 Supabase 迁移 | — | 无 | UNVERIFIED |

## 4. 优化小结

只列实际做出且有理由的改动。

| 改动 | 理由 | 实测影响 |
|---|---|---|
| 入队时课程上下文在事务连接上解析(482655e) | 事务持有连接时再向同一连接池取 5+ 个连接会池饥饿 | 复现(池 max 3,12 个并发 v2 账号):修复前事务超时(maxWait 5 s/事务 15 s),修复后毫秒级完成。除此无其他测量 |
| 线性 PDF 分词器取代正则扫描(3efcde0) | 长度正则二次回溯,5 MB 输入可卡住 worker 事件循环;并关闭 `/Length` 伪造 | 评估者实测:修复前 40k 位数字 566 ms,按比例外推 5 MB 为小时级(外推,非实测);修复后 5 MB 最坏输入约 0.3 s。分词器被调用两次,约 0.7 s/文档(评估者估算) |
| 课程加载按课程 advisory lock(93aa1a7) | 并发加载竞态(M1-06) | 无测量;靠并发集成测试证明正确性 |
| 请求集合规范化(documents 排序、objectiveIds 排序、拒绝重复)(482655e) | 重试顺序不同不应使幂等键冲突 | 无测量 |
| 更严格的 schema 与校验(strictObject、alignment/inputsHash/边校验)(b30ee05) | 防止未知字段与被篡改的课包通过 | 无测量 |
| 无 usage 的调用按上限计费、截断直接回退(dd66f80) | 预算不再低估失败重试;避免相同限制重复截断 | 无测量 |
| 编译/渲染确定性失败为最终失败(0470a8f) | 避免重复付费模型调用 | 无测量 |
| 失败尝试清理自己的上传前缀(5c19588) | 避免在私有 Storage 积累孤儿 | 无测量 |

## 5. 最终验证报告

均在本分支 HEAD(`4fa31f4`)上执行;输出摘自验证记录。

| 命令 | 最终结果 | 基线(`fa66973`) |
|---|---|---|
| `pnpm lint` | 退出 0 | 退出 0 |
| `pnpm typecheck` | 退出 0 | 退出 0 |
| `pnpm test` | 19 文件,581 通过 | 18 文件,432 通过 |
| `pnpm test:integration` | 7 文件,186 通过 | 168 通过 |
| `pnpm test:supabase` | 27 通过 | 26 通过 |
| `pnpm test:latex` | 5 文件,42 通过(真实镜像) | 40 通过 |
| `pnpm curriculum:validate` | 3 个数据集 ok(sample、两个合成) | 同 |
| `pnpm build` | 编译成功 | 未在基线记录 |
| e2e(`pnpm test:e2e`) | 14 通过 | 14(M5 合并时 CI) |

注:集成与 e2e 输出含预期的失败路径日志(如 `job_failed`、`attempt_cleanup_failed`、`artifact_sign_failed`),来自负面测试。基线中 build 与 e2e 未重跑,e2e 数字来自 M5 合并时的 CI 记录。

**未运行 / 未验证**
- 合并结果上的 CI:合并后填写。
- staging 演练(托管 Supabase 迁移、托管 Storage 缓存头、Stripe)。
- 真实 LLM 提供方(除 D-42 记录的那一次受控评估)。
- 生产主机上的 Docker/gVisor。
- 人工数学抽查与教师对模型文字的审阅;移动端 PDF 内嵌;CDN 缓存键。
- 未执行的单项:docker 级十六进制转义 `\pdfcatalog` 负面测试;脚本退出码与 `curriculum-load` 工作流的端到端执行;legacy 作业在真实浏览器中的轮询到刷新转换。

## 6. 剩余风险与已知限制

**最终评审:待完成(final review pending)。** 评审文件 `final-review.md` 在撰写时尚不存在,因此**不能**声明"无 Critical/High 遗留";R8-01(High)已由再评审确认修复,除此之外本文没有已知的 Critical/High,但这不等于最终评审结论。不声明生产就绪。

| 序 | 项 | 级别 | 裁定 | 判断错误时的代价 |
|---|---|---|---|---|
| 1 | R8-06 PDF 检查器不校验 xref 偏移 | Medium | 搁置:宿主 PDF 扫描是纵深防御;评估者建议的 xref 一致性校验是 PDF 结构校验器,有拒绝合法 pdfTeX 输出的风险且超出 M1–M5 审计范围;缺口在旧扫描器中已存在;前提是攻击者已绕过转义器并控制文件字节;主要控制是渲染器白名单与操作系统沙箱(TeX 文件写入测试为负)。 | 若 TeX 注入与文件写入同时成功,恶意 PDF 可携带主动内容 |
| 2 | M5-02 RLS 不反映删除/发布状态 | Medium | 已记录;当前无删除功能,仅所有者自己的数据 | 删除功能上线前不修,则软删除课包的 PDF 仍可由所有者自行签名取得 |
| 3 | M5-01 崩溃后孤儿对象无对账 | Medium | 延期到 P3,已在文档中如实说明 | 私有 Storage 中孤儿累积(成本与保留) |
| 4 | M2-02 IP 限流未接入 | Medium | 延期,计划 P3-T2 | 单 IP 多账号滥用免费额度 |
| 5 | M4-09 非生产占位 PDF 可结算 | Low | 延期;依赖 `NODE_ENV=production` | staging 若未设置则可能向用户提供占位文件并扣额度 |
| 6 | M4-10 镜像不可复现重建、超时设置可矛盾 | Low | 延期;生产用 digest | 基础镜像漂移使 CI 变红;慢速合法三文档包可能报超时 |
| 7 | M3-05 残留(词形计算、"dot xyz"、无 Unicode 折叠) | Low | 已知限制 | 模型可能在叙述中写出错误的词形计算(仅导师可见文字) |
| 8 | M4-02 `assertTexIsSafe` 缺口;M4-04 PDF 级答案缺席/字体嵌入未测;R8-03/04/05;M4-08 | Low | 延期 | 纵深防御削弱;细节见 2.1/2.2 |
| 9 | M3-07 调用前无成本检查 | Low | 延期 | 单次调用预算超支,有效答案可能被丢弃 |
| 10 | M2-05 v1 入口在 docker 配置下必失败 | Low | 延期至 D-37/M7 | 用户得到必然失败并消耗限流配额;额度不扣 |
| 11 | M5-09 托管 Supabase 存储迁移;缓存头与 CDN | Low | UNVERIFIED,需 staging | 部署工作流可能中途失败;托管侧对象可能被缓存 |
| 12 | N-1、Q-3、M1-08/09 等 | Low | 延期 | 需手动刷新;极端情况下残留对象;大数据集性能未测 |
| 13 | M1-02/03 仅 TS 层校验 | Low | 数据库 CHECK 未同步 | 绕过校验器直接写库可入库空来源信息 |

另:沙箱主机、gVisor、真实模型质量、教师审阅、真实课程数据集(CM)均未验证,上线前必须单独完成(CLAUDE.md §11)。

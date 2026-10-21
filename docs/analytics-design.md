# 分析事件设计(草案,D-84;**未批准实现**,需先确认)

状态:设计草案。不含迁移与代码。依据:D-84(两层:GA4 + 一方事件)、CLAUDE.md §9(日志与指标不含课程内容、学生信息、JWT、签名 URL)。

## 1. 先区分:哪些指标不需要新表
下列指标可由**现有表**直接查询得到,不需要事件表,也不受同意横幅影响(它们是服务运行记录):
- 激活:每个账户的首个成功生成时间(`generation_job` / `lesson_revision`)。
- 回访:账户在不同日期/周产生的作业数。
- 每课成本与耗时:作业的 token/成本字段与阶段耗时(若已记录;**待核对**哪些字段已存在)。
- 额度消耗:`usage_bucket` / `usage_reservation`。
- 调整次数(B2 之后):调整记录。

**只有现有表没有的信号才需要事件**:界面行为(打开预览、下载了哪份 PDF、点击"申请此主题"、提交反馈、横幅选择)和营销站流量。

## 2. 表 `analytics_event`(仅用于上面的界面信号)
| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid pk | 默认随机 |
| occurred_at | timestamptz | UTC |
| owner_id | uuid null | 已登录用户的 profile id;匿名事件为空。随账户删除一并删除 |
| name | text | 白名单内的事件名(见 §3),CHECK 约束 |
| params | jsonb | 仅白名单键,值为短字符串/数字/布尔;CHECK 大小上限 |
| consent | text | 记录时的同意级别:`all` / `essential` |

要点:
- 不存邮箱、IP、User-Agent、URL、课程/作业/修订 ID。`params` 里的主题与级别用稳定的主题 ID(来自数据集,非用户输入)。
- `deny` 级别**不写入**任何此类事件。
- 数据保留期:默认 13 个月(`TEST VALUE`,待隐私声明确定),定期清理作业。
- 运行时角色只能 INSERT 自己的行、不能读取他人数据;读取仅限管理账户/脚本。RLS 与授权需像其他业务表一样单独测试。

## 3. 事件白名单(初版,可增删)
`topic_requested`(topic_text 已截断并清洗、可选课程标签)、`pdf_downloaded`(document=notes|worksheet|solutions)、`preview_opened`(view=pdf|draft)、`feedback_submitted`(无正文,正文走反馈通道)、`consent_chosen`(level)、`signup_started`。每个事件的允许参数键写在一个 TypeScript 常量里,`track()` 对其余一律丢弃。

注意:`topic_requested` 的自由文本可能含个人信息 → 只存**选自列表**的主题 ID 或经长度限制的文本,并在界面提示"不要填写学生姓名";是否保留自由文本待定。

## 4. `track()` 封装
- 单一入口:`track(name, params)`(客户端)→ 服务器端接口校验后写入;服务器端动作直接调用同一校验函数。
- 校验:名称在白名单;参数键在该事件的允许集合;值类型与长度;超出即丢弃(开发环境抛错)。
- 同意:服务器读取 `np_consent` Cookie(`all`/`essential`/`deny`);缺失按 `deny`。`deny` 不写入;`essential` 写入 `consent='essential'`;`all` 另外允许 GA。
- 速率限制与请求大小上限,防止被刷表。
- 开发/测试/CI 由环境开关关闭 GA;一方写入在测试中可用。

## 5. GA4(B4)
- 仅在 `np_consent=all` 后动态加载;`anonymize`/不设 `user_id`;不发送邮箱;页面路径清洗为路由模式(`/lessons/:id`);事件走同一个 `track()`,白名单子集转发。
- CSP:新增响应头,仅在启用时放行 Google 脚本与连接域名(**域名与限额需对照官方文档核实,此处未核实**)。

## 6. 同意横幅(B4)
三个按钮:全部接受 / 仅必要 / 全部拒绝;选择写入 `np_consent` Cookie(一年,SameSite=Lax)并记录一次 `consent_chosen`(deny 时不记录);页脚"Cookie 设置"可更改。

## 7. 需要你确认
1. 初版事件白名单是否合适(§3),尤其 `topic_requested` 是否允许自由文本。
2. 保留期 13 个月是否可接受。
3. 一方"界面信号"事件在 `essential` 级别是否记录(D-84 的假设;需有资质的人核对是否算"必要")。
4. 是否先只做本文件的表与 `track()`(B0),GA4/横幅/CSP 留到 B4。

## 8. 验证计划
单元:白名单与参数校验拒绝禁用键、超长值;`deny` 不写入。集成(真实 Postgres):RLS/角色权限、账户删除级联、保留期清理。E2E:无同意时无任何分析请求;下载 PDF 产生一条事件且不含 ID。

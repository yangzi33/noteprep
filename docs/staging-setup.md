# Staging 环境准备清单

> 状态:2026-10-19 已按本清单完成首次 staging 部署,并手动验证了 注册 → 确认邮件 → 登录 → `/account`。仓库不会自动创建任何云资源或部署(CLAUDE.md §2);Supabase、Vercel、Stripe 测试账户由用户创建。首次部署中遇到的问题记录在 §7。仍待做:签名密钥检查与 anon 权限查询(见 §6)。
> 相关:[architecture](architecture.md) §2 §11–§12 · [database-roles](database-roles.md) · [security-and-privacy](security-and-privacy.md) §9 · [decisions](decisions.md)

## 1. Supabase(staging 项目)

1. **签名密钥**:在项目的 JWT/签名密钥设置里启用**非对称签名密钥**,并撤销旧的 HS256 共享密钥(否则持有旧密钥的人可伪造任意用户令牌,见 security-and-privacy §9 第 0 项)。完成后用 `tests/supabase` 中的伪造令牌用例思路在 staging 上手动复验。
2. **Auth**:开启邮箱确认;关闭匿名登录;在 Authentication → URL Configuration 把 **Site URL** 设为 staging 域名(目前 `https://noteprep.app`),并把 `<域名>/auth/callback` 加入 Redirect URLs。**必须在第一次注册之前完成**:否则确认邮件会回退到默认的 `http://localhost:3000`。
3. **Data API**:迁移后确认 `anon`/`authenticated` 对 public 表没有权限(可跑 `information_schema.role_table_grants` 查询,期望 0 行)。若不使用 Data API 可在设置里关闭。
4. **迁移**:通过 GitHub Actions 的 `Database migrations` 工作流(手动触发、`staging` 环境、需审批)执行 `prisma migrate deploy`。先选 action **status**:有未应用迁移时它会显示为红色(`prisma migrate status` 在有待应用迁移时退出码为 1,这是预期的信息而不是故障);再选 action **deploy** 才会真正执行 "Apply migrations" 步骤(默认值是 status,容易忽略)。`MIGRATION_DATABASE_URL` 用 **会话池**(端口 5432,用户 `postgres.<project-ref>`);直连是 IPv6,GitHub 托管 runner 可能连不上(未验证)。**不要**用 Supabase 的 GitHub 集成/Branching 管理迁移(它读取 `supabase/migrations`,本项目的迁移在 `prisma/migrations`)。
5. **运行时登录用户**:**迁移完成之后**,在该项目的 SQL Editor 里执行 `docs/database-roles.md` 里的 `CREATE ROLE web_login …`(`IN ROLE app_runtime` 依赖迁移创建的组角色),密码来自你的密钥管理(建议 `openssl rand -hex 24`,避免 URL 转义),不进仓库。随后用 database-roles.md 里的查询确认 `web_login` 属于 `app_runtime`;若不是,执行 `GRANT app_runtime TO web_login;`。
6. **加载示例课程数据(仅 staging,M2 起需要才能看到 `/prepare` 的内容)**:先在 Vercel 的 staging 环境变量里设置 `CURRICULUM_ALLOW_SAMPLE=1` 并重新部署;然后运行 GitHub Actions 的 `Load curriculum dataset` 工作流(手动触发、受同一组环境审批保护),选 environment **staging**、dataset `sample-math/sample-1`,先用默认的 **validate**(只检查文件,不碰数据库),再选 **load**。它用与迁移相同的 `MIGRATION_DATABASE_URL`(所有者连接),幂等:重复运行显示 `unchanged`。**示例数据只会被加载到 staging**:工作流只在 staging 传 `--allow-sample`,生产环境即使选了示例数据集也会被加载器拒绝(`KIND_NOT_ALLOWED`)。生产环境**不要**设置 `CURRICULUM_ALLOW_SAMPLE`。
7. **连接串**(Supabase 连接页取值,逐项核对 Prisma 7 与池化的组合):
   - Web(Vercel):事务池(端口 6543,`pgbouncer=true`),用户 `web_login.<project-ref>`(池化连接的用户名要带项目 ref)。
   - Worker:会话池或直连,用户 `worker_login`。
   - 迁移:直连/会话池,所有者角色。

## 2. Vercel(staging 项目)

- 导入 GitHub 仓库;Framework Preset 必须是 **Next.js**(仓库里的 `vercel.json` 也声明了 `framework: nextjs`);根目录为仓库根;Build/Output/Install 命令都不要覆盖;pnpm 版本来自 `packageManager`。预设为 "Other" 时构建能通过,但会报 `No Output Directory named "public" found`,域名随后返回 Vercel 自己的 404。
- 私有仓库:Hobby 团队不能从 GitHub 组织的私有仓库部署;个人账户仓库按其规则处理。
- 把 staging 用的生产分支/预览分支与环境变量对应起来(Vercel 的 Preview / Production 作用域分开设置)。

| 变量 | 值来源 | 作用域 |
|---|---|---|
| `DATABASE_URL` | staging 的 `web_login` 事务池连接串 | staging 部署 |
| `NEXT_PUBLIC_SUPABASE_URL` | staging 项目 URL | staging 部署 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | staging 的 publishable key | staging 部署 |
| `NEXT_PUBLIC_SITE_URL` | staging 域名 | staging 部署 |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | (可选)公开的联系邮箱;构建时写入,改动需重新部署;不设置则只显示文字提示 | staging 部署 |
| `CURRICULUM_ALLOW_SAMPLE` | `1`(显示**示例**课程数据,仅 staging;**生产不设置**) | staging 部署(M2 起需要) |
| (Phase 3)`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET` | Stripe **测试模式** | staging 部署 |

Vercel 的变量类型:`DATABASE_URL` 选 **Secret**(保存后只能覆盖、不能查看,先存进密码管理器);三个 `NEXT_PUBLIC_*` 选 **Config**(本来就会进浏览器)。环境勾选 **Production 和 Preview**,不要勾 Development(那是 `vercel dev`/`vercel env pull` 的本地用途)。**变量改动只对新的部署生效,`NEXT_PUBLIC_*` 在构建时写入**,所以改完要重新部署。

**不要**在 Vercel 放:迁移连接串、Supabase secret key、LLM key(Web 不使用它们,见 architecture §2 的秘密清单)。

## 3. GitHub

- 创建环境 `staging`(和之后的 `production`),设置**必需审批人**;只在这些环境里放 `MIGRATION_DATABASE_URL`。
- 分支保护(建议):`main` 要求 `CI` 工作流的三个作业通过。
- `CI` 工作流在 pull request 上运行且**没有仓库秘密**;不要改成 `pull_request_target`。

## 4. Stripe(测试模式)

Phase 3 才接入。届时:在测试模式创建一个月度价格,把价格 ID 放进服务端白名单配置;为 staging 的 webhook 端点创建独立的签名密钥;固定 API 版本。价格、币种、每期额度仍是待定项(decisions D-16),测试值必须标注为 `TEST VALUE`。

## 5. Linux 主机(worker + 编译沙箱)

这是 architecture §11 里"可信 worker + 无秘密 runner + 每任务一次性沙箱"的运行位置,**不是 Vercel 能承担的**(Vercel Functions 有最长运行时间、无法提供 TeX 镜像和隔离控制)。

**已定(D-52..D-56)**:staging 主机拓扑、镜像、发布、存活/停止与冒烟已有设计和仓库内实现:worker 容器由宿主 Docker 运行,LaTeX 沙箱由独立账户 `noteprep-runner` 的 rootless Docker 运行。**具体的主机搭建、秘密、拉取、验证与演练步骤全部在 [worker-host-runbook.md](worker-host-runbook.md)**;这里不再重复。主机文件在 [deploy/host/](../deploy/host/)。**这些都没有在真实主机上运行过(UNVERIFIED)**。

**主机的最低要求(摘要;细则见 runbook §1)**:x86_64 Linux、cgroup v2、systemd、**不需要任何入站端口**(只需出站访问 Supabase 数据库与 Storage、LLM 供应商、Stripe API 和镜像注册表)、自动安全更新、磁盘与时间同步监控。规格先用小规格通用 VM,以真实编译耗时与并发数为依据再定(不在此臆测)。

**仍未决定**:
- gVisor/Firecracker 是否需要(D-44/D-52:首版没有 gVisor,与 rootless 的兼容性未验证);
- 运维责任:内核/OS 补丁、容器运行时升级、TeX 镜像重建后重跑沙箱测试、日志与告警(目前只有可检索日志和只读 SQL,没有告警系统)、磁盘清理。

**需要你决定**:托管商与规格(decisions D-20)。主机购买、DNS、注册表访问令牌等都由你操作;runbook 不包含任何创建付费资源的命令。

## 6. 首次部署前的检查

- [ ] 第 1 节签名密钥已改为非对称并撤销旧密钥,且已复验
- [ ] 重定向白名单只含 staging 域名
- [ ] `anon`/`authenticated` 无权限已在 staging 上查询确认
- [ ] 迁移通过受审批的工作流执行,而不是本机
- [ ] `web_login` 已创建、属于 `app_runtime`,Vercel 中使用的是 `web_login`(`worker_login` 等 Phase 2 有 worker 主机时再建)
- [ ] Vercel 环境变量中没有迁移凭据、secret key、LLM key
- [ ] 首次登录 → 创建账户 → `/account` 在 staging 上手动走通

## 7. 首次部署遇到的问题(2026-10-19)

| 现象 | 原因 | 处理 |
|---|---|---|
| 域名返回 Vercel 的 `404 NOT_FOUND`;构建日志 `No Output Directory named "public" found` | Framework Preset 是 "Other",没有可用的部署 | 预设改为 Next.js 后重新部署(并提交 `vercel.json`) |
| 确认邮件的链接 `redirect_to` 是 `http://localhost:3000` | Supabase 的 Site URL 和 Redirect URLs 还没配置,请求的回调地址不在白名单,回退到默认值 | 先配置 Site URL 与白名单,再注册(已确认过的账户可直接用密码登录) |
| `Migration status` 步骤红色 | 有待应用迁移时 `prisma migrate status` 退出码为 1;当时 deploy 流程会因此提前终止(已在 PR #3 修复) | 状态运行红色属正常;应用迁移要选 action **deploy** |
| `/account`:`table public.profile does not exist` | 迁移尚未应用到 staging | 运行 `Database migrations` → deploy |
| `/account`:`permission denied for table profile` (42501) | `web_login` 不属于 `app_runtime`(登录用户在迁移之前创建,或创建时漏了 `IN ROLE`) | `GRANT app_runtime TO web_login;` |

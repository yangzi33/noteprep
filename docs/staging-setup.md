# Staging 环境准备清单

> 状态:清单,**尚未执行**。仓库不会自动创建任何云资源或部署(CLAUDE.md §2)。Supabase、Vercel、Stripe 测试账户已由用户创建;下面是需要由人完成的配置与它们之间的对应关系。
> 相关:[architecture](architecture.md) §2 §11–§12 · [database-roles](database-roles.md) · [security-and-privacy](security-and-privacy.md) §9 · [decisions](decisions.md)

## 1. Supabase(staging 项目)

1. **签名密钥**:在项目的 JWT/签名密钥设置里启用**非对称签名密钥**,并撤销旧的 HS256 共享密钥(否则持有旧密钥的人可伪造任意用户令牌,见 security-and-privacy §9 第 0 项)。完成后用 `tests/supabase` 中的伪造令牌用例思路在 staging 上手动复验。
2. **Auth**:开启邮箱确认;关闭匿名登录;Site URL 与重定向白名单只包含 staging 的 Vercel 域名(含 `/auth/callback`)。
3. **Data API**:迁移后确认 `anon`/`authenticated` 对 public 表没有权限(可跑 `information_schema.role_table_grants` 查询,期望 0 行)。若不使用 Data API 可在设置里关闭。
4. **迁移**:通过 GitHub Actions 的 `Database migrations` 工作流(手动触发、`staging` 环境、需审批)执行 `prisma migrate deploy`。**不要**用 Supabase 的 GitHub 集成/Branching 管理迁移(它读取 `supabase/migrations`,本项目的迁移在 `prisma/migrations`)。
5. **运行时登录用户**:迁移完成后,用所有者连接执行 `docs/database-roles.md` 里的 `CREATE ROLE web_login …` / `worker_login …`,密码来自你的密钥管理,不进仓库。
6. **连接串**(Supabase 连接页取值,逐项核对 Prisma 7 与池化的组合):
   - Web(Vercel):事务池(端口 6543,`pgbouncer=true`),用户 `web_login`。
   - Worker:会话池或直连,用户 `worker_login`。
   - 迁移:直连/会话池,所有者角色。

## 2. Vercel(staging 项目)

- 导入 GitHub 仓库;Framework: Next.js;根目录为仓库根;pnpm 版本来自 `packageManager`。
- 私有仓库:Hobby 团队不能从 GitHub 组织的私有仓库部署;个人账户仓库按其规则处理。
- 把 staging 用的生产分支/预览分支与环境变量对应起来(Vercel 的 Preview / Production 作用域分开设置)。

| 变量 | 值来源 | 作用域 |
|---|---|---|
| `DATABASE_URL` | staging 的 `web_login` 事务池连接串 | staging 部署 |
| `NEXT_PUBLIC_SUPABASE_URL` | staging 项目 URL | staging 部署 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | staging 的 publishable key | staging 部署 |
| `NEXT_PUBLIC_SITE_URL` | staging 域名 | staging 部署 |
| (Phase 3)`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET` | Stripe **测试模式** | staging 部署 |

**不要**在 Vercel 放:迁移连接串、Supabase secret key、LLM key(Web 不使用它们,见 architecture §2 的秘密清单)。

## 3. GitHub

- 创建环境 `staging`(和之后的 `production`),设置**必需审批人**;只在这些环境里放 `MIGRATION_DATABASE_URL`。
- 分支保护(建议):`main` 要求 `CI` 工作流的三个作业通过。
- `CI` 工作流在 pull request 上运行且**没有仓库秘密**;不要改成 `pull_request_target`。

## 4. Stripe(测试模式)

Phase 3 才接入。届时:在测试模式创建一个月度价格,把价格 ID 放进服务端白名单配置;为 staging 的 webhook 端点创建独立的签名密钥;固定 API 版本。价格、币种、每期额度仍是待定项(decisions D-16),测试值必须标注为 `TEST VALUE`。

## 5. Linux 主机(worker + 编译沙箱)

这是 architecture §11 里"可信 worker + 无秘密 runner + 每任务一次性沙箱"的运行位置,**不是 Vercel 能承担的**(Vercel Functions 有最长运行时间、无法提供 TeX 镜像和隔离控制)。

**何时需要**:Phase 1 的 worker 骨架在本机运行即可;**Phase 2 的沙箱 spike 之前需要一台真实 Linux 机器**(见 implementation-plan P2-T6)。

**最低要求(待 spike 实测确认,以下规格是假设,不是结论)**:

| 项 | 要求 |
|---|---|
| 系统 | x86_64 Linux(Ubuntu LTS 之类),可装 Docker 或 Podman,并能安装 gVisor `runsc` |
| 网络 | 只需**出站**:Supabase 数据库与 Storage、LLM 供应商、Stripe API。**不需要任何入站端口**(worker 轮询数据库领取任务) |
| 隔离 | 沙箱容器 `--network none`、只读根、非 root、丢弃全部能力、资源限制;runner 使用没有任何凭据的独立 OS 账户(机制由 spike 决定) |
| 规格 | 先用小规格通用 VM 起步,以真实编译耗时与并发数为依据再定(不在此臆测) |
| 运维 | 内核/OS 补丁、容器运行时与 gVisor 升级、TeX 镜像重建后重跑沙箱测试、日志与告警、磁盘清理 |

**候选**:任何能满足以上要求的普通云 VM(通用 VPS 或云厂商实例)。gVisor 是否需要 KVM/嵌套虚拟化取决于所选平台(其文档页未明确,**待验证**);若 gVisor 与 TeX 不兼容或负面测试不过,备选是 Firecracker 微虚拟机(需要 KVM 或裸金属,选型会随之改变)。

**需要你决定**:托管商与规格(decisions D-20)。建议等 Phase 2 的 spike 在任意一台临时 Linux 机器上跑通后再定,以免选错平台。

## 6. 首次部署前的检查

- [ ] 第 1 节签名密钥已改为非对称并撤销旧密钥,且已复验
- [ ] 重定向白名单只含 staging 域名
- [ ] `anon`/`authenticated` 无权限已在 staging 上查询确认
- [ ] 迁移通过受审批的工作流执行,而不是本机
- [ ] `web_login`/`worker_login` 已创建,Vercel 中使用的是 `web_login`
- [ ] Vercel 环境变量中没有迁移凭据、secret key、LLM key
- [ ] 首次登录 → 创建账户 → `/account` 在 staging 上手动走通

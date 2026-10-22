# 数据库角色与迁移权限

> 状态:P1-T3 已实现于 `prisma/migrations/*_constraints_roles_rls`;下面描述的是该迁移实际创建的内容。staging 的 `web_login` 已创建(2026-10-19);生产尚未创建(未部署)。
> 相关:[architecture](architecture.md) §4–§5 · [security-and-privacy](security-and-privacy.md) §3

## 角色模型

迁移创建两个 **NOLOGIN 组角色**,且显式设置 `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`:

| 角色 | 用途 | 权限概要 |
|---|---|---|
| `app_runtime` | Vercel Web 运行时 | 业务表 SELECT/INSERT/UPDATE;`subscription` 只读;`webhook_event` 只可 SELECT/INSERT;**任何表都没有 DELETE**;无 DDL;无权访问 `_prisma_migrations` |
| `worker_runtime` | 独立 worker | 业务表 SELECT/INSERT/UPDATE;对 `lesson`、`lesson_revision`、`generation_job`、`idempotency_key`、`rate_limit_window`、`webhook_event` 有 DELETE;**对 `profile`、`usage_*`、`subscription` 没有 DELETE**;可读 `usage_bucket_drift`;无 DDL;无权访问 `_prisma_migrations` |

**草稿表(`*_draft_tables` 迁移)**:`draft`、`draft_version` 对 `app_runtime` 只授予 SELECT/INSERT/UPDATE(**没有 DELETE**),对 `worker_runtime` 授予 SELECT/UPDATE/DELETE(没有 INSERT;worker 只负责清理过期草稿,`draft_version` 随 `draft` 级联删除)。两张表同样启用 RLS 和 `runtime_roles_all` 策略,授权逐表书写,没有使用 `ON ALL TABLES`。

迁移执行者(`migrator`)就是表的所有者,**不在迁移里创建**,只在受保护的发布流程中使用其连接串。`anon`、`authenticated`(Supabase Data API 角色,如存在)与 `PUBLIC` 对业务表没有任何权限,并撤销了默认授权;所有业务表都启用 RLS,对两个运行时角色用 `USING (true)` 的策略放行 —— **owner 隔离由服务端 DAL 负责,不由 RLS 负责**。

角色属性在 `CREATE ROLE` 时指定,**迁移不使用 `ALTER ROLE` 改属性**:Supabase 的 `postgres` 所有者不是真正的超级用户,`ALTER ROLE … NOBYPASSRLS` 会被拒绝(P1-T5 在真实 Supabase 上发现)。如果同名角色已存在,迁移会断言它没有任何提升属性,否则失败。

## 登录用户

带密码的登录用户**不写进迁移**,由各环境单独创建并加入组角色:

```sql
CREATE ROLE web_login    LOGIN PASSWORD '<来自密钥管理>' IN ROLE app_runtime;
CREATE ROLE worker_login LOGIN PASSWORD '<来自密钥管理>' IN ROLE worker_runtime;
```

**必须在迁移之后执行**:`app_runtime`/`worker_runtime` 是迁移创建的。创建后确认组成员关系,缺少时补授权(第一次 staging 部署正是因为缺少成员关系,出现了 `permission denied for table profile`):

```sql
select r.rolname as member, g.rolname as in_group
from pg_roles r
join pg_auth_members m on m.member = r.oid
join pg_roles g on g.oid = m.roleid
where r.rolname in ('web_login', 'worker_login');

GRANT app_runtime TO web_login;      -- 幂等;必要时再对 worker_login 授予 worker_runtime
```

集成测试(`tests/integration/global-setup.ts`)对每次运行创建随机名称的临时登录用户并在结束时删除。

## 新增表时的检查清单

集成测试 `tests/integration/schema.test.ts` 会在以下情况失败,提醒补全:新表没有启用 RLS;`PUBLIC`/`anon`/`authenticated` 获得了权限;`app_runtime` 获得了 DELETE。新表的迁移必须显式写出对两个运行时角色的 GRANT 与 RLS 策略(不要使用 `ON ALL TABLES`,它会把 `_prisma_migrations` 一并授权 —— 这正是测试发现过的一个缺陷)。

## 连接串(见 architecture §5.2)

| 使用者 | 连接方式 |
|---|---|
| Web(Vercel) | 事务池(Supabase 6543,`pgbouncer=true`),`web_login` |
| Worker | 会话池或直连,`worker_login` |
| 迁移 | 直连/会话池,所有者角色,仅在受保护流程中 |

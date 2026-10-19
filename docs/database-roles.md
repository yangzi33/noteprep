# 数据库角色与迁移权限

> 状态:P1-T3 已实现于 `prisma/migrations/*_constraints_roles_rls`;下面描述的是该迁移实际创建的内容。生产/staging 的登录用户尚未创建(未部署)。
> 相关:[architecture](architecture.md) §4–§5 · [security-and-privacy](security-and-privacy.md) §3

## 角色模型

迁移创建两个 **NOLOGIN 组角色**,且显式设置 `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`:

| 角色 | 用途 | 权限概要 |
|---|---|---|
| `app_runtime` | Vercel Web 运行时 | 业务表 SELECT/INSERT/UPDATE;`subscription` 只读;`webhook_event` 只可 SELECT/INSERT;**任何表都没有 DELETE**;无 DDL;无权访问 `_prisma_migrations` |
| `worker_runtime` | 独立 worker | 业务表 SELECT/INSERT/UPDATE;对 `lesson`、`lesson_revision`、`generation_job`、`idempotency_key`、`rate_limit_window`、`webhook_event` 有 DELETE;**对 `profile`、`usage_*`、`subscription` 没有 DELETE**;可读 `usage_bucket_drift`;无 DDL;无权访问 `_prisma_migrations` |

迁移执行者(`migrator`)就是表的所有者,**不在迁移里创建**,只在受保护的发布流程中使用其连接串。`anon`、`authenticated`(Supabase Data API 角色,如存在)与 `PUBLIC` 对业务表没有任何权限,并撤销了默认授权;所有业务表都启用 RLS,对两个运行时角色用 `USING (true)` 的策略放行 —— **owner 隔离由服务端 DAL 负责,不由 RLS 负责**。

## 登录用户

带密码的登录用户**不写进迁移**,由各环境单独创建并加入组角色:

```sql
CREATE ROLE web_login    LOGIN PASSWORD '<来自密钥管理>' IN ROLE app_runtime;
CREATE ROLE worker_login LOGIN PASSWORD '<来自密钥管理>' IN ROLE worker_runtime;
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

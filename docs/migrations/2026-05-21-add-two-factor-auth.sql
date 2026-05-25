-- 增量迁移：Better Auth twoFactor 插件 TOTP + 备份码支持。
-- 背景：账户页新增「二步验证」管理；邮箱密码登录后若已启用 2FA，先返回
-- twoFactorRequired，前端再调 /api/auth/two-factor/verify-totp 或 /verify-backup-code。
-- LinuxDo SSO 走独立路径，不经过 2FA。
-- 幂等：使用 add column if not exists / create table if not exists / create index if not exists。

ALTER TABLE better_auth_user
    ADD COLUMN IF NOT EXISTS two_factor_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS better_auth_two_factor (
    id text PRIMARY KEY,
    secret text NOT NULL,
    backup_codes text NOT NULL,
    verified boolean NOT NULL DEFAULT true,
    user_id text NOT NULL REFERENCES better_auth_user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_better_auth_two_factor_user_id
    ON better_auth_two_factor(user_id);

CREATE INDEX IF NOT EXISTS idx_better_auth_two_factor_secret
    ON better_auth_two_factor(secret);

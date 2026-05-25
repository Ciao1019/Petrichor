-- =============================================================================
-- 创建第一个超级管理员账号
-- =============================================================================
-- 使用前提：已经执行过 docs/petrichor-init.sql（表结构已建好）
--
-- 1. 先在本地生成 bcrypt 密码哈希：
--      cd apps/web
--      node -e "console.log(require('bcryptjs').hashSync('你的明文密码', 10))"
--    复制输出（形如 $2a$10$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx）。
--
-- 2. 修改下面 v_email / v_password_hash / v_nickname 三个变量，然后在
--    Supabase SQL Editor 整段执行。幂等：重复执行不会重复插入。
-- =============================================================================

do $$
declare
    v_email         text := 'admin@example.com';                    -- TODO: 改成你的邮箱
    v_password_hash text := '$2a$10$REPLACE_WITH_BCRYPT_HASH';      -- TODO: 改成上一步生成的哈希
    v_nickname      text := 'Admin';                                -- TODO: 改成显示名
    v_auth_user_id  text := gen_random_uuid()::text;
    v_username      text := split_part(v_email, '@', 1);
begin
    -- Better Auth 主用户表
    insert into better_auth_user (id, name, email, email_verified, created_at, updated_at)
    values (v_auth_user_id, v_nickname, lower(v_email), true, now(), now())
    on conflict (email) do nothing;

    -- 业务用户表（带 SUPER_ADMIN 角色）
    insert into petrichor_user (auth_user_id, email, password_hash, system_role, user_type, username, nickname)
    values (v_auth_user_id, lower(v_email), v_password_hash, 'SUPER_ADMIN', 'LOCAL', v_username, v_nickname)
    on conflict (email) do nothing;

    -- Better Auth credential 凭据（用于邮箱密码登录）
    insert into better_auth_account (id, account_id, provider_id, user_id, password, created_at, updated_at)
    values (gen_random_uuid()::text, v_auth_user_id, 'credential', v_auth_user_id, v_password_hash, now(), now())
    on conflict (provider_id, account_id) do nothing;
end $$;

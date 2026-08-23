// Package auth 复刻 src/server/auth 的双会话认证体系与用户模型。
package auth

import (
	"strconv"
	"time"

	httpx "petrichor/api/internal/httpx"
)

// User 对应 petrichor_user 表记录。
type User struct {
	ID               int64     `db:"id"`
	AuthUserID       *string   `db:"auth_user_id"`
	Email            string    `db:"email"`
	PasswordHash     string    `db:"password_hash"`
	SystemRole       string    `db:"system_role"`
	UserType         string    `db:"user_type"`
	LinuxDoAccountID *string   `db:"linuxdo_account_id"`
	LinuxDoUsername  *string   `db:"linuxdo_username"`
	LinuxDoEmail     *string   `db:"linuxdo_email"`
	Username         *string   `db:"username"`
	Nickname         *string   `db:"nickname"`
	Avatar           *string   `db:"avatar"`
	Signature        *string   `db:"signature"`
	CreatedAt        time.Time `db:"created_at"`
	UpdatedAt        time.Time `db:"updated_at"`
}

// IsSuperAdmin 是否超级管理员。
func (u *User) IsSuperAdmin() bool { return u.SystemRole == "SUPER_ADMIN" }

// ToUserResponse 对应 mappers.ts 的 toUserResponse。
func (u *User) ToUserResponse() map[string]any {
	return map[string]any{
		"id":              strconv.FormatInt(u.ID, 10),
		"email":           u.Email,
		"systemRole":      u.SystemRole,
		"userType":        u.UserType,
		"linuxDoBound":    trimNonEmpty(u.LinuxDoAccountID),
		"linuxDoUsername": u.LinuxDoUsername,
		"linuxDoEmail":    u.LinuxDoEmail,
		"username":        u.Username,
		"nickname":        u.Nickname,
		"avatar":          u.Avatar,
	}
}

// ToUserProfileResponse 对应 mappers.ts 的 toUserProfileResponse。
// 2FA 已按产品决策移除，恒为 false，仅保留字段形状兼容前端。
func (u *User) ToUserProfileResponse() map[string]any {
	resp := u.ToUserResponse()
	resp["signature"] = u.Signature
	resp["twoFactorEnabled"] = false
	resp["createdAt"] = httpx.FormatISO(u.CreatedAt)
	resp["updatedAt"] = httpx.FormatISO(u.UpdatedAt)
	return resp
}

func trimNonEmpty(s *string) bool {
	if s == nil {
		return false
	}
	return *s != ""
}

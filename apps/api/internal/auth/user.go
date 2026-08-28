// Package auth 实现会话认证与用户模型。
package auth

import (
	"strconv"
	"time"

	httpx "petrichor/api/internal/httpx"
)

// User 对应 petrichor_user 表记录。
type User struct {
	ID               int64     `db:"id"`
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

// ToUserResponse 生成客户端用户信息。
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

// ToUserProfileResponse 生成客户端用户资料。
func (u *User) ToUserProfileResponse() map[string]any {
	resp := u.ToUserResponse()
	resp["signature"] = u.Signature
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

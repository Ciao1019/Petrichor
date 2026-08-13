package auth

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/authsession"
	"github.com/Ciao1019/Petrichor/apps/api/ent/user"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type Service struct {
	client *ent.Client
	cfg    *config.Config
}

func NewService(client *ent.Client, cfg *config.Config) *Service {
	return &Service{client: client, cfg: cfg}
}

type UserDTO struct {
	ID              string  `json:"id"`
	Email           string  `json:"email"`
	SystemRole      string  `json:"systemRole"`
	UserType        string  `json:"userType"`
	LinuxDoBound    bool    `json:"linuxDoBound"`
	LinuxDoUsername *string `json:"linuxDoUsername"`
	LinuxDoEmail    *string `json:"linuxDoEmail"`
	Username        *string `json:"username"`
	Nickname        *string `json:"nickname"`
	Avatar          *string `json:"avatar"`
}

type UserProfileDTO struct {
	UserDTO
	Signature *string `json:"signature"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

type AuthResult struct {
	Token string  `json:"token"`
	User  UserDTO `json:"user"`
}

func ToUserDTO(u *ent.User) UserDTO {
	return UserDTO{
		ID:              fmt.Sprintf("%d", u.ID),
		Email:           u.Email,
		SystemRole:      NormalizeSystemRole(u.SystemRole, u.ID),
		UserType:        NormalizeUserType(u.UserType, u.PasswordHash),
		LinuxDoBound:    u.LinuxDoAccountID != nil && strings.TrimSpace(*u.LinuxDoAccountID) != "",
		LinuxDoUsername: u.LinuxDoUsername,
		LinuxDoEmail:    u.LinuxDoEmail,
		Username:        u.Username,
		Nickname:        u.Nickname,
		Avatar:          u.Avatar,
	}
}

func NormalizeSystemRole(systemRole string, userID int64) string {
	role := strings.TrimSpace(systemRole)
	if role != "" {
		if role == "SUPER_ADMIN" {
			return "SUPER_ADMIN"
		}
		return "USER"
	}
	if userID == 1 {
		return "SUPER_ADMIN"
	}
	return "USER"
}

func IsSuperAdmin(u *ent.User) bool {
	return u != nil && NormalizeSystemRole(u.SystemRole, u.ID) == "SUPER_ADMIN"
}

func NormalizeUserType(userType, passwordHash string) string {
	if value := strings.TrimSpace(userType); value != "" {
		return value
	}
	if strings.TrimSpace(passwordHash) != "" {
		return "LOCAL"
	}
	return "LINUXDO"
}

func ToProfileDTO(u *ent.User) UserProfileDTO {
	return UserProfileDTO{
		UserDTO:   ToUserDTO(u),
		Signature: u.Signature,
		CreatedAt: u.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt: u.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func (s *Service) Login(ctx context.Context, email, password, ip, userAgent string) (*AuthResult, *ent.AuthSession, string, error) {
	normalized := NormalizeEmail(email)
	u, err := s.client.User.Query().
		Where(user.EmailEqualFold(normalized)).
		Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, nil, "", response.Unauthorized("邮箱或密码错误")
		}
		return nil, nil, "", err
	}
	if !CheckPassword(u.PasswordHash, password) {
		return nil, nil, "", response.Unauthorized("邮箱或密码错误")
	}

	token, session, err := s.CreateSession(ctx, u.ID, ip, userAgent)
	if err != nil {
		return nil, nil, "", err
	}
	return &AuthResult{Token: token, User: ToUserDTO(u)}, session, token, nil
}

func (s *Service) Register(ctx context.Context, email, password, name, ip, userAgent string) (*AuthResult, string, error) {
	if !s.cfg.RegisterEnabled {
		return nil, "", response.Forbidden("当前未开放注册")
	}
	normalized := NormalizeEmail(email)
	exists, err := s.client.User.Query().Where(user.EmailEqualFold(normalized)).Exist(ctx)
	if err != nil {
		return nil, "", err
	}
	if exists {
		return nil, "", response.BadRequest("邮箱已被注册")
	}

	hash, err := HashPassword(password)
	if err != nil {
		return nil, "", err
	}
	role, err := s.resolveSystemRoleForNewUser(ctx)
	if err != nil {
		return nil, "", err
	}

	username := strings.Split(normalized, "@")[0]
	if username == "" {
		username = name
	}
	nickname := strings.TrimSpace(name)
	u, err := s.client.User.Create().
		SetEmail(normalized).
		SetPasswordHash(hash).
		SetSystemRole(role).
		SetUserType("LOCAL").
		SetUsername(username).
		SetNickname(nickname).
		Save(ctx)
	if err != nil {
		return nil, "", err
	}

	token, _, err := s.CreateSession(ctx, u.ID, ip, userAgent)
	if err != nil {
		return nil, "", err
	}
	return &AuthResult{Token: token, User: ToUserDTO(u)}, token, nil
}

func (s *Service) Logout(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	hash := HashSessionToken(token)
	_, err := s.client.AuthSession.Update().
		Where(
			authsession.TokenHashEQ(hash),
			authsession.RevokedAtIsNil(),
		).
		SetRevokedAt(time.Now().UTC()).
		Save(ctx)
	return err
}

func (s *Service) CurrentUser(ctx context.Context, token string) (*ent.User, *ent.AuthSession, error) {
	if token == "" {
		return nil, nil, response.Unauthorized("")
	}
	hash := HashSessionToken(token)
	now := time.Now().UTC()
	session, err := s.client.AuthSession.Query().
		Where(
			authsession.TokenHashEQ(hash),
			authsession.RevokedAtIsNil(),
			authsession.ExpiresAtGT(now),
		).
		Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, nil, response.Unauthorized("")
		}
		return nil, nil, err
	}

	u, err := s.client.User.Get(ctx, session.UserID)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, nil, response.Unauthorized("")
		}
		return nil, nil, err
	}

	expiresAt := SessionExpiresAt(now, s.cfg.SessionExpire)
	session, err = session.Update().
		SetExpiresAt(expiresAt).
		SetLastSeenAt(now).
		Save(ctx)
	if err != nil {
		return nil, nil, err
	}
	return u, session, nil
}

func (s *Service) ChangePassword(ctx context.Context, userID int64, currentPassword, newPassword string) error {
	u, err := s.client.User.Get(ctx, userID)
	if err != nil {
		return err
	}
	if !CheckPassword(u.PasswordHash, currentPassword) {
		return response.BadRequest("当前密码错误")
	}
	if CheckPassword(u.PasswordHash, newPassword) {
		return response.BadRequest("新密码不能与当前密码相同")
	}
	hash, err := HashPassword(newPassword)
	if err != nil {
		return err
	}
	return s.client.User.UpdateOneID(userID).
		SetPasswordHash(hash).
		Exec(ctx)
}

type ProfilePatch struct {
	Nickname  optionalNullableString
	Avatar    optionalNullableString
	Signature optionalNullableString
}

func (s *Service) UpdateProfile(ctx context.Context, userID int64, patch ProfilePatch) (*ent.User, error) {
	upd := s.client.User.UpdateOneID(userID)
	if patch.Nickname.Present {
		v := ""
		if patch.Nickname.Value != nil {
			v = strings.TrimSpace(*patch.Nickname.Value)
		}
		if v == "" {
			upd.ClearNickname()
		} else {
			upd.SetNickname(v)
		}
	}
	if patch.Avatar.Present {
		v := ""
		if patch.Avatar.Value != nil {
			v = strings.TrimSpace(*patch.Avatar.Value)
		}
		if v == "" {
			upd.ClearAvatar()
		} else {
			upd.SetAvatar(v)
		}
	}
	if patch.Signature.Present {
		v := ""
		if patch.Signature.Value != nil {
			v = strings.TrimSpace(*patch.Signature.Value)
		}
		if v == "" {
			upd.ClearSignature()
		} else {
			upd.SetSignature(v)
		}
	}
	return upd.Save(ctx)
}

// CreateSession 签发会话令牌并落库。
func (s *Service) CreateSession(ctx context.Context, userID int64, ip, userAgent string) (string, *ent.AuthSession, error) {
	token, err := IssueSessionToken()
	if err != nil {
		return "", nil, err
	}
	now := time.Now().UTC()
	builder := s.client.AuthSession.Create().
		SetTokenHash(HashSessionToken(token)).
		SetUserID(userID).
		SetExpiresAt(SessionExpiresAt(now, s.cfg.SessionExpire)).
		SetLastSeenAt(now)
	if ip != "" {
		builder.SetIP(ip)
	}
	if userAgent != "" {
		builder.SetUserAgent(userAgent)
	}
	session, err := builder.Save(ctx)
	if err != nil {
		return "", nil, err
	}
	return token, session, nil
}

func (s *Service) resolveSystemRoleForNewUser(ctx context.Context) (string, error) {
	if s.cfg.RegisterDefaultSystemRole == "SUPER_ADMIN" {
		return "SUPER_ADMIN", nil
	}
	count, err := s.client.User.Query().
		Where(user.SystemRoleEQ("SUPER_ADMIN")).
		Count(ctx)
	if err != nil {
		return "", err
	}
	if count == 0 {
		return "SUPER_ADMIN", nil
	}
	return "USER", nil
}

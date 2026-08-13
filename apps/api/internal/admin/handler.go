package admin

import (
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/user"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type Handler struct {
	client *ent.Client
}

func NewHandler(client *ent.Client) *Handler {
	return &Handler{client: client}
}

func requireSuperAdmin(c *gin.Context) (*ent.User, bool) {
	u := auth.MustUser(c)
	if !auth.IsSuperAdmin(u) {
		response.Fail(c, response.Forbidden("仅超级管理员可执行该操作"))
		return nil, false
	}
	return u, true
}

type UserDTO struct {
	ID         string  `json:"id"`
	Email      string  `json:"email"`
	SystemRole string  `json:"systemRole"`
	UserType   string  `json:"userType"`
	Username   *string `json:"username"`
	Nickname   *string `json:"nickname"`
	Avatar     *string `json:"avatar"`
	Signature  *string `json:"signature"`
	CreatedAt  string  `json:"createdAt"`
	UpdatedAt  string  `json:"updatedAt"`
}

func toUserDTO(u *ent.User) UserDTO {
	return UserDTO{
		ID:         fmt.Sprintf("%d", u.ID),
		Email:      u.Email,
		SystemRole: auth.NormalizeSystemRole(u.SystemRole, u.ID),
		UserType:   auth.NormalizeUserType(u.UserType, u.PasswordHash),
		Username:   u.Username,
		Nickname:   u.Nickname,
		Avatar:     u.Avatar,
		Signature:  u.Signature,
		CreatedAt:  u.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:  u.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func (h *Handler) ListUsers(c *gin.Context) {
	if _, ok := requireSuperAdmin(c); !ok {
		return
	}
	var raw map[string]any
	if err := c.ShouldBindJSON(&raw); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	keyword, err := validateAdminKeyword(raw["keyword"])
	if err != nil {
		response.Fail(c, err)
		return
	}
	pageNum, pageSize := normalizeAdminPagination(raw)
	orders, err := resolveAdminUserOrder(raw["orderByColumn"], raw["isAsc"])
	if err != nil {
		response.Fail(c, err)
		return
	}
	query := h.client.User.Query()
	if keyword = strings.TrimSpace(keyword); keyword != "" {
		query = query.Where(user.Or(
			user.EmailContainsFold(keyword),
			user.UsernameContainsFold(keyword),
			user.NicknameContainsFold(keyword),
		))
	}
	total, err := query.Clone().Count(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	orderOptions := make([]user.OrderOption, 0, len(orders))
	for _, order := range orders {
		if order.Ascending {
			orderOptions = append(orderOptions, user.OrderOption(ent.Asc(order.Field)))
		} else {
			orderOptions = append(orderOptions, user.OrderOption(ent.Desc(order.Field)))
		}
	}
	query = query.Order(orderOptions...)
	rows, err := query.Offset((pageNum - 1) * pageSize).Limit(pageSize).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	out := make([]UserDTO, 0, len(rows))
	for _, row := range rows {
		out = append(out, toUserDTO(row))
	}
	response.TableData(c, out, total)
}

type createUserRequest struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required,min=6"`
	Name     string `json:"name"`
	Role     string `json:"systemRole"`
}

func (h *Handler) CreateUser(c *gin.Context) {
	if _, ok := requireSuperAdmin(c); !ok {
		return
	}
	var raw map[string]any
	if err := c.ShouldBindJSON(&raw); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	input, err := validateAdminCreateInput(raw)
	if err != nil {
		response.Fail(c, err)
		return
	}
	email := auth.NormalizeEmail(input.Email)
	exists, err := h.client.User.Query().Where(user.EmailEqualFold(email)).Exist(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if exists {
		response.Fail(c, response.BadRequest("邮箱已被注册"))
		return
	}
	hash, err := auth.HashPassword(input.Password)
	if err != nil {
		response.Fail(c, err)
		return
	}
	username := strings.Split(email, "@")[0]
	row, err := h.client.User.Create().
		SetEmail(email).
		SetPasswordHash(hash).
		SetSystemRole(input.SystemRole).
		SetUserType("LOCAL").
		SetUsername(username).
		SetNickname(input.Name).
		Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toUserDTO(row))
}

type deleteUserRequest struct {
	UserID string `json:"userId" binding:"required"`
}

func (h *Handler) DeleteUser(c *gin.Context) {
	current, ok := requireSuperAdmin(c)
	if !ok {
		return
	}
	var raw map[string]any
	if err := c.ShouldBindJSON(&raw); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := validateAdminDeleteInput(raw["userId"])
	if err != nil {
		response.Fail(c, err)
		return
	}
	if id == current.ID {
		response.Fail(c, response.BadRequest("不允许删除当前登录用户"))
		return
	}
	target, err := h.client.User.Get(c.Request.Context(), id)
	if ent.IsNotFound(err) {
		response.Fail(c, response.NotFound("用户不存在"))
		return
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	if auth.IsSuperAdmin(target) {
		count, err := h.client.User.Query().Where(user.SystemRoleEQ("SUPER_ADMIN")).Count(c.Request.Context())
		if err != nil {
			response.Fail(c, err)
			return
		}
		if count <= 1 {
			response.Fail(c, response.BadRequest("至少保留一个超级管理员"))
			return
		}
	}
	n, err := h.client.User.Delete().Where(user.IDEQ(id)).Exec(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if n == 0 {
		response.Fail(c, response.NotFound("用户不存在"))
		return
	}
	response.OK(c, gin.H{})
}

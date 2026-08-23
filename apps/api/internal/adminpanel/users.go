// users.go 移植 src/server/admin/handlers.ts + logic.ts：
// 用户列表（关键字/排序/分页）、创建（bcrypt + better_auth 双写）与删除。
package adminpanel

import (
	"errors"
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"

	"petrichor/api/internal/auth"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/storage"
)

var emailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// NormalizeSystemRole 复刻 normalizeSystemRole：空角色时 id===1 兜底超管。
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

func isSuperAdminRole(systemRole string, userID int64) bool {
	return NormalizeSystemRole(systemRole, userID) == "SUPER_ADMIN"
}

// NormalizeUserType 复刻 normalizeUserType：无类型时按有无密码哈希推断。
func NormalizeUserType(userType, passwordHash string) string {
	normalized := strings.TrimSpace(userType)
	if normalized != "" {
		return normalized
	}
	if strings.TrimSpace(passwordHash) != "" {
		return "LOCAL"
	}
	return "LINUXDO"
}

// buildAdminUserItem 复刻 buildAdminUserItem 的响应形状。
func buildAdminUserItem(u *auth.User) map[string]any {
	return map[string]any{
		"id":         strconv.FormatInt(u.ID, 10),
		"email":      u.Email,
		"systemRole": NormalizeSystemRole(u.SystemRole, u.ID),
		"userType":   NormalizeUserType(u.UserType, u.PasswordHash),
		"username":   u.Username,
		"nickname":   u.Nickname,
		"avatar":     u.Avatar,
		"signature":  u.Signature,
		"createdAt":  httpx.FormatISO(u.CreatedAt),
		"updatedAt":  httpx.FormatISO(u.UpdatedAt),
	}
}

// ===== 排序解析 =====

type adminUserOrder struct {
	column    string // 已映射为 petrichor_user 的物理列名
	direction string
}

var adminOrderColumnMap = map[string]string{
	"avatar":      "avatar",
	"created_at":  "created_at",
	"email":       "email",
	"id":          "id",
	"nickname":    "nickname",
	"signature":   "signature",
	"system_role": "system_role",
	"updated_at":  "updated_at",
	"username":    "username",
	"user_type":   "user_type",
}

// escapeOrderBy 只允许 [0-9A-Za-z_,]。
func escapeOrderBy(raw string) (string, error) {
	for i := 0; i < len(raw); i++ {
		ch := raw[i]
		ok := (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') ||
			(ch >= 'a' && ch <= 'z') || ch == '_' || ch == ','
		if !ok {
			return "", httpx.BadRequest("排序参数有误")
		}
	}
	return raw, nil
}

// toUnderScoreCase 复刻同名函数：驼峰转下划线，逗号/下划线后不大写转换。
func toUnderScoreCase(value string) string {
	out := make([]byte, 0, len(value)+4)
	for i := 0; i < len(value); i++ {
		ch := value[i]
		if ch >= 'A' && ch <= 'Z' {
			if i > 0 && value[i-1] != ',' && value[i-1] != '_' {
				out = append(out, '_')
			}
			out = append(out, ch+'a'-'A')
			continue
		}
		out = append(out, ch)
	}
	return string(out)
}

// resolveAdminUserOrder 复刻 resolveAdminUserOrder：默认 updated_at desc, id desc。
func resolveAdminUserOrder(orderByRaw, isAscRaw string) ([]adminUserOrder, error) {
	orderByColumn := strings.TrimSpace(orderByRaw)
	isAsc := strings.TrimSpace(isAscRaw)
	if orderByColumn == "" || isAsc == "" {
		return []adminUserOrder{
			{column: "updated_at", direction: "desc"},
			{column: "id", direction: "desc"},
		}, nil
	}

	safeOrderBy, err := escapeOrderBy(orderByColumn)
	if err != nil {
		return nil, err
	}
	var columns []string
	for _, column := range strings.Split(safeOrderBy, ",") {
		mapped := toUnderScoreCase(strings.TrimSpace(column))
		if mapped == "" {
			continue
		}
		columns = append(columns, mapped)
	}

	directionsRaw := strings.ReplaceAll(isAsc, "ascending", "asc")
	directionsRaw = strings.ReplaceAll(directionsRaw, "descending", "desc")
	var directions []string
	for _, direction := range strings.Split(directionsRaw, ",") {
		directions = append(directions, strings.ToLower(strings.TrimSpace(direction)))
	}
	if len(directions) != 1 && len(directions) != len(columns) {
		return nil, httpx.BadRequest("排序参数有误")
	}

	order := make([]adminUserOrder, 0, len(columns))
	for index, column := range columns {
		direction := directions[0]
		if len(directions) != 1 {
			direction = directions[index]
		}
		if direction != "asc" && direction != "desc" {
			return nil, httpx.BadRequest("排序参数有误")
		}
		mapped, ok := adminOrderColumnMap[column]
		if !ok {
			return nil, httpx.BadRequest("排序参数有误")
		}
		order = append(order, adminUserOrder{column: mapped, direction: direction})
	}
	return order, nil
}

func numberFromRaw(raw any) (float64, bool) {
	value := toFloatValue(raw)
	if value != value { // NaN
		return 0, false
	}
	return value, true
}

func isDigitString(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// UserList POST /api/admin/user/list。
func UserList(c *gin.Context) {
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}

	keyword := toStringValue(body["keyword"])
	if runeLen(keyword) > 200 {
		httpx.HandleError(c, httpx.BadRequest("关键字长度不能超过 200"))
		return
	}
	keyword = strings.TrimSpace(keyword)

	pageNum := int64(1)
	if v, ok := numberFromRaw(body["pageNum"]); ok {
		n := int64(v)
		if float64(n) == v && n > 0 {
			pageNum = n
		}
	}
	pageSize := int64(20)
	if v, ok := numberFromRaw(body["pageSize"]); ok {
		n := int64(v)
		if float64(n) == v && n > 0 {
			pageSize = n
		}
	}

	order, oerr := resolveAdminUserOrder(toStringValue(body["orderByColumn"]), toStringValue(body["isAsc"]))
	if oerr != nil {
		httpx.HandleError(c, oerr)
		return
	}
	orderClauses := make([]string, 0, len(order))
	for _, item := range order {
		orderClauses = append(orderClauses, item.column+" "+item.direction)
	}
	orderByClause := strings.Join(orderClauses, ", ")

	filterSQL := ""
	args := []any{}
	if keyword != "" {
		pattern := "%" + keyword + "%"
		filterSQL = ` WHERE email ILIKE $1 OR username ILIKE $1 OR nickname ILIKE $1`
		args = append(args, pattern)
	}

	ctx := c.Request.Context()
	pool := db.Pool()
	var total int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM petrichor_user`+filterSQL, args...).Scan(&total); err != nil {
		httpx.HandleError(c, err)
		return
	}

	query := `SELECT ` + auth.UserColumns + ` FROM petrichor_user` + filterSQL +
		` ORDER BY ` + orderByClause +
		` LIMIT ` + strconv.FormatInt(pageSize, 10) +
		` OFFSET ` + strconv.FormatInt((pageNum-1)*pageSize, 10)
	rows, err := pool.Query(ctx, query, args...)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		u, serr := auth.ScanUser(rows)
		if serr != nil {
			httpx.HandleError(c, serr)
			return
		}
		items = append(items, buildAdminUserItem(u))
	}
	if rerr := rows.Err(); rerr != nil {
		httpx.HandleError(c, rerr)
		return
	}
	httpx.TableData(c, items, total)
}

// UserCreate POST /api/admin/user/create。
func UserCreate(c *gin.Context) {
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}

	email := strings.TrimSpace(toStringValue(body["email"]))
	password := toStringValue(body["password"])
	name := strings.TrimSpace(toStringValue(body["name"]))
	rawSystemRole := ""
	if body["systemRole"] != nil {
		rawSystemRole = strings.TrimSpace(toStringValue(body["systemRole"]))
	}

	if email == "" {
		httpx.HandleError(c, httpx.BadRequest("不能为空"))
		return
	}
	if !emailPattern.MatchString(email) {
		httpx.HandleError(c, httpx.BadRequest("不是一个合法的电子邮件地址"))
		return
	}
	if strings.TrimSpace(password) == "" {
		httpx.HandleError(c, httpx.BadRequest("不能为空"))
		return
	}
	if pwLen := runeLen(password); pwLen < 6 || pwLen > 50 {
		httpx.HandleError(c, httpx.BadRequest("个数必须在6和50之间"))
		return
	}
	if name == "" {
		httpx.HandleError(c, httpx.BadRequest("不能为空"))
		return
	}
	if runeLen(name) > 80 {
		httpx.HandleError(c, httpx.BadRequest("个数必须在0和80之间"))
		return
	}
	if rawSystemRole != "" && rawSystemRole != "USER" && rawSystemRole != "SUPER_ADMIN" {
		httpx.HandleError(c, httpx.BadRequest("systemRole 非法"))
		return
	}

	normalizedEmail := strings.ToLower(email)
	ctx := c.Request.Context()
	pool := db.Pool()

	// 与 TS 一致：先精确邮箱查重，再在事务里做小写查重 + better_auth 查重
	var existingID int64
	err := pool.QueryRow(ctx,
		`SELECT id FROM petrichor_user WHERE email = $1 LIMIT 1`, email).Scan(&existingID)
	if err == nil {
		httpx.HandleError(c, httpx.BadRequest("邮箱已被注册"))
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		httpx.HandleError(c, err)
		return
	}

	tx, terr := pool.Begin(ctx)
	if terr != nil {
		httpx.HandleError(c, terr)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var dupID int64
	dupErr := tx.QueryRow(ctx,
		`SELECT id FROM petrichor_user WHERE lower(email) = $1 LIMIT 1`, normalizedEmail).Scan(&dupID)
	if dupErr == nil {
		httpx.HandleError(c, httpx.BadRequest("邮箱已被注册"))
		return
	}
	if !errors.Is(dupErr, pgx.ErrNoRows) {
		httpx.HandleError(c, dupErr)
		return
	}
	authDupErr := tx.QueryRow(ctx,
		`SELECT id FROM better_auth_user WHERE lower(email) = $1 LIMIT 1`, normalizedEmail).Scan(&dupID)
	if authDupErr == nil {
		httpx.HandleError(c, httpx.BadRequest("邮箱已被注册"))
		return
	}
	if !errors.Is(authDupErr, pgx.ErrNoRows) {
		httpx.HandleError(c, authDupErr)
		return
	}

	authUserID := storage.NewUUID()
	passwordHash, berr := bcrypt.GenerateFromPassword([]byte(password), 10)
	if berr != nil {
		httpx.HandleError(c, berr)
		return
	}
	username := strings.TrimSpace(strings.SplitN(normalizedEmail, "@", 2)[0])
	if username == "" {
		username = name
	}

	// 角色决策：显式 SUPER_ADMIN 生效；否则系统还没有任何超管时首位自动晋升
	systemRole := "USER"
	if rawSystemRole == "SUPER_ADMIN" {
		systemRole = "SUPER_ADMIN"
	} else {
		var superAdminCount int64
		if cerr := tx.QueryRow(ctx,
			`SELECT count(*) FROM petrichor_user WHERE system_role = 'SUPER_ADMIN'`).Scan(&superAdminCount); cerr != nil {
			httpx.HandleError(c, cerr)
			return
		}
		if superAdminCount == 0 {
			systemRole = "SUPER_ADMIN"
		}
	}

	if _, ierr := tx.Exec(ctx,
		`INSERT INTO better_auth_user (id, name, email, email_verified, image, created_at, updated_at)
		 VALUES ($1,$2,$3,true,NULL,now(),now())`,
		authUserID, name, normalizedEmail); ierr != nil {
		httpx.HandleError(c, ierr)
		return
	}
	if _, ierr := tx.Exec(ctx,
		`INSERT INTO better_auth_account (id, account_id, provider_id, user_id, password, created_at, updated_at)
		 VALUES ($1,$2,'credential',$3,$4,now(),now())`,
		storage.NewUUID(), authUserID, authUserID, string(passwordHash)); ierr != nil {
		httpx.HandleError(c, ierr)
		return
	}

	user, uerr := auth.ScanUser(tx.QueryRow(ctx,
		`INSERT INTO petrichor_user
		 (auth_user_id, email, password_hash, system_role, user_type, username, nickname, avatar, signature)
		 VALUES ($1,$2,$3,$4,'LOCAL',$5,$6,NULL,NULL) RETURNING `+auth.UserColumns,
		authUserID, normalizedEmail, string(passwordHash), systemRole, username, name))
	if uerr != nil {
		httpx.HandleError(c, uerr)
		return
	}
	if cerr := tx.Commit(ctx); cerr != nil {
		httpx.HandleError(c, cerr)
		return
	}
	httpx.OK(c, buildAdminUserItem(user))
}

// UserDelete POST /api/admin/user/delete。
func UserDelete(c *gin.Context) {
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	userIDRaw := strings.TrimSpace(toStringValue(body["userId"]))
	if !isDigitString(userIDRaw) {
		httpx.HandleError(c, httpx.BadRequest("用户ID非法"))
		return
	}
	userID, perr := strconv.ParseInt(userIDRaw, 10, 64)
	if perr != nil {
		httpx.HandleError(c, httpx.BadRequest("用户ID非法"))
		return
	}

	currentUser := auth.CurrentUser(c)
	if userID == currentUser.ID {
		httpx.HandleError(c, httpx.BadRequest("不允许删除当前登录用户"))
		return
	}

	ctx := c.Request.Context()
	pool := db.Pool()
	target, terr := auth.ScanUser(pool.QueryRow(ctx,
		`SELECT `+auth.UserColumns+` FROM petrichor_user WHERE id = $1 LIMIT 1`, userID))
	if errors.Is(terr, pgx.ErrNoRows) {
		httpx.HandleError(c, httpx.NotFound("用户不存在"))
		return
	}
	if terr != nil {
		httpx.HandleError(c, terr)
		return
	}

	if isSuperAdminRole(target.SystemRole, target.ID) {
		var superAdminCount int64
		if cerr := pool.QueryRow(ctx,
			`SELECT count(*) FROM petrichor_user WHERE system_role = 'SUPER_ADMIN'`).Scan(&superAdminCount); cerr != nil {
			httpx.HandleError(c, cerr)
			return
		}
		if superAdminCount <= 1 {
			httpx.HandleError(c, httpx.BadRequest("至少保留一个超级管理员"))
			return
		}
	}

	tx, terr := pool.Begin(ctx)
	if terr != nil {
		httpx.HandleError(c, terr)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	authUserID := strings.TrimSpace(derefString(target.AuthUserID))
	if authUserID != "" {
		if _, derr := tx.Exec(ctx, `DELETE FROM better_auth_user WHERE id = $1`, authUserID); derr != nil {
			httpx.HandleError(c, derr)
			return
		}
	}
	if _, derr := tx.Exec(ctx, `DELETE FROM petrichor_user WHERE id = $1`, target.ID); derr != nil {
		httpx.HandleError(c, derr)
		return
	}
	if cerr := tx.Commit(ctx); cerr != nil {
		httpx.HandleError(c, cerr)
		return
	}
	httpx.OK(c, gin.H{})
}

func derefString(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

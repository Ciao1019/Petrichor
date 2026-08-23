// db.go publicapi 的数据库入口。
package publicapi

import "petrichor/api/internal/db"

// pool 便捷入口（与 kb 包同款）。
var pool = db.Pool

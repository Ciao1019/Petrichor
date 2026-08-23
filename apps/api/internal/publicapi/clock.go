// clock.go 时间入口，便于测试替换。
package publicapi

import "time"

func timeNow() time.Time { return time.Now() }

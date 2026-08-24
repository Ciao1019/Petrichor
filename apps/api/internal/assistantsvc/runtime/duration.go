package runtime

import "time"

func msDuration(ms int64) time.Duration { return time.Duration(ms) * time.Millisecond }

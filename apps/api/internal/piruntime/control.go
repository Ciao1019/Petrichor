package piruntime

// Control 只接受用户消息，不允许改变工具、模型或系统角色。
type Control struct {
	Sequence int64  `json:"sequence"`
	Mode     string `json:"mode"`
	Text     string `json:"text"`
}

package config

// AgentPiConfig 指定私有 Pi 子进程。entry 留空时自动查找开发源码或镜像内的构建产物。
type AgentPiConfig struct {
	Command string `toml:"command"`
	Entry   string `toml:"entry"`
}

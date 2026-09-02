## 项目简介

**Fastfetch** 是一个类似 Neofetch 的系统信息展示工具, 主要使用 C 语言编写, 注重性能和可定制性。它能够以美观的方式获取和显示系统信息。

### 主要特点

* **积极维护**: 与已停止维护的 Neofetch 不同, Fastfetch 持续更新
* **高性能**: 执行速度更快, 响应更迅速
* **跨平台支持**: Linux、macOS、Windows 7+、Android、FreeBSD、OpenBSD、NetBSD、DragonFly、Haiku 和 SunOS
* **功能丰富**: 支持更多模块和配置选项
* **高度可定制**: 使用 _<span style="color: #93C47D;">JSONC</span>_ 格式配置文件, 支持 JSON Schema 智能提示
* **更精确**: 支持 Wayland 协议, 数据显示更准确

### 项目信息

* **GitHub 仓库**: [https://github.com/fastfetch-cli/fastfetch](https://github.com/fastfetch-cli/fastfetch)
* **Star 数量**: 17.5 k+
* **许可证**: MIT License
* **主要维护者**: [CarterLi](mention:CarterLi)
* **原作者**: [LinusDierheimer](mention:LinusDierheimer)

***

## 安装指南

### Linux

#### Debian/Ubuntu

```bash
# Debian 13 及更高版本
apt install fastfetch

# Debian 11+ / Ubuntu 20.04+ - 下载 deb 包安装
wget https://github.com/fastfetch-cli/fastfetch/releases/download/VERSION/fastfetch-linux-<架构>.deb
sudo dpkg -i fastfetch-linux-<架构>.deb
```

#### Arch Linux

```bash
pacman -S fastfetch
```

#### Fedora

```bash
dnf install fastfetch
```

#### Gentoo

```bash
emerge --ask app-misc/fastfetch
```

#### Alpine

```bash
apk add --upgrade fastfetch
```

#### NixOS

```bash
nix-shell -p fastfetch
```

#### OpenSUSE

```bash
zypper install fastfetch
```

#### Void Linux

```bash
xbps-install fastfetch
```

#### 使用 Linuxbrew

如果你的发行版没有打包或版本过旧:

```bash
brew install fastfetch
```

### MacOS

#### Homebrew

```bash
brew install fastfetch
```

#### MacPorts

```bash
sudo port install fastfetch
```

### Windows

#### Scoop

```bash
scoop install fastfetch
```

#### Chocolatey

```bash
choco install fastfetch
```

#### Winget

```bash
winget install fastfetch
```

#### MSYS 2 MinGW

```bash
pacman -S mingw-w64-<子系统>-<架构>-fastfetch
```

### BSD 系统

#### FreeBSD

```bash
pkg install fastfetch
```

#### NetBSD

```bash
pkgin in fastfetch
```

#### OpenBSD

```bash
pkg_add fastfetch
```

#### DragonFly BSD

```bash
pkg install fastfetch
```

### Android (Termux)

```bash
pkg install fastfetch
```

***

## 快速开始

### 基本运行

安装完成后, 直接运行:

```bash
fastfetch
```

这将使用默认配置显示系统信息和 ASCII Logo。

### 查看帮助

```bash
# 查看所有选项
fastfetch --help

# 查看特定选项的帮助
fastfetch -h <选项名>

# 查看模块格式帮助
fastfetch -h <模块名>-format
```

### 查看可用资源

```bash
# 列出所有可用模块
fastfetch --list-modules

# 列出所有可用 Logo
fastfetch --list-logos

# 列出所有预设配置
fastfetch --list-presets

# 列出配置文件搜索路径
fastfetch --list-config-paths

# 列出数据文件搜索路径
fastfetch --list-data-paths

# 列出编译支持的特性
fastfetch --list-features
```

### 运行所有模块

```bash
fastfetch -c all.jsonc
```

这将显示所有支持的模块, 帮助你了解可用功能。

***

## 配置文件

### 配置文件位置

默认配置文件路径:

```
~/.config/fastfetch/config.jsonc
```

配置文件搜索顺序:

1. 当前工作目录
2. `~/.local/share/fastfetch/presets/`
3. `/usr/share/fastfetch/presets/`

### 生成配置文件

```bash
# 生成最小配置文件
fastfetch --gen-config

# 生成完整配置文件(包含所有可选项)
fastfetch --gen-config-full

# 生成到指定路径
fastfetch --gen-config /path/to/config.jsonc

# 强制覆盖现有配置
fastfetch --gen-config-force

# 输出到标准输出
fastfetch --gen-config -
```

### 配置文件结构

Fastfetch 使用 **JSONC**(JSON with Comments) 格式, 支持注释。

基本结构:

```jsonc
{
    "$schema": "https://github.com/fastfetch-cli/fastfetch/raw/dev/doc/json_schema.json",
    "logo": {
        // Logo 配置
    },
    "display": {
        // 显示设置
    },
    "modules": [
        // 模块列表
    ]
}
```

### JSON Schema 支持

在配置文件开头添加 `$schema` 字段可以在支持的编辑器 (如 VS Code、Helix) 中获得智能提示和语法检查:

```json
{
    "$schema": "https://github.com/fastfetch-cli/fastfetch/raw/dev/doc/json_schema.json"
}
```

***

## 常用命令

### 指定配置文件

```bash
# 使用自定义配置文件
fastfetch -c /path/to/config.jsonc

# 使用预设配置
fastfetch -c neofetch
fastfetch -c hardware
fastfetch -c paleofetch

# 禁用配置加载
fastfetch -c none
```

### 自定义结构

使用 `-s` 或 `--structure` 指定要显示的模块 (用冒号分隔):

```bash
fastfetch -s title:separator:os:kernel:uptime:memory

# 只显示操作系统信息
fastfetch -s os

# 显示多个模块
fastfetch -s OS:Kernel:Packages:Terminal:Memory:Locale
```

### 自定义 Logo

```bash
# 使用内置 Logo
fastfetch --logo arch

# 禁用 Logo
fastfetch --logo none
fastfetch -l none

# 使用自定义图片
fastfetch -l /path/to/logo.png

# 使用 ASCII 艺术文件
fastfetch --logo /path/to/ascii-art.txt
```

### 修改 Logo 颜色

```bash
# 修改 Logo 颜色
fastfetch --logo-color-1 red --logo-color-2 green

# 使用小型 Logo
fastfetch --logo-type small
```

### 输出格式

```bash
# JSON 格式输出
fastfetch --format json
fastfetch -j

# 查看特定模块的 JSON 数据
fastfetch -s os:kernel --format json
```

### 性能统计

```bash
# 显示每个模块的执行时间
fastfetch --stat
```

### 保存配置

将当前命令行选项保存为配置文件:

```bash
fastfetch -s os:kernel:memory --logo arch --gen-config
```

***

## 模块配置

### 可用模块类型

常用模块包括:

**系统信息**

* `title` - 用户名@主机名
* `separator` - 分隔线
* `os` - 操作系统
* `kernel` - 内核版本
* `uptime` - 系统运行时间
* `packages` - 已安装软件包

**硬件信息**

* `host` - 主机型号
* `cpu` - CPU 信息
* `gpu` - GPU 信息
* `memory` - 内存使用
* `disk` - 磁盘使用
* `battery` - 电池状态
* `display` - 显示器信息

**软件信息**

* `shell` - Shell 类型
* `terminal` - 终端类型
* `de` - 桌面环境
* `wm` - 窗口管理器
* `theme` - 主题
* `icons` - 图标主题
* `font` - 字体

**网络信息**

* `localip` - 本地 IP 地址
* `publicip` - 公网 IP 地址

**其他**

* `colors` - 终端颜色展示
* `custom` - 自定义文本
* `command` - 执行命令输出

### 模块配置方式

#### 简单配置

使用字符串形式启用默认配置:

```jsonc
{
    "modules": [
        "title",
        "separator",
        "os",
        "kernel",
        "uptime"
    ]
}
```

#### 高级配置

使用对象形式自定义模块:

```jsonc
{
    "modules": [
        {
            "type": "os",
            "key": "操作系统",
            "keyColor": "blue",
            "format": "{name} {version}"
        },
        {
            "type": "cpu",
            "key": " CPU",
            "format": "{name} ({cores}核)"
        },
        {
            "type": "memory",
            "key": " 内存",
            "format": "{used} / {total} ({percentage}%)"
        }
    ]
}
```

### 模块格式化

每个模块支持自定义格式字符串:

```jsonc
{
    "type": "cpu",
    "format": "{name} ({cores-physical}C/{cores-logical}T) @ {freq-max}"
}
```

查看模块支持的格式占位符:

```bash
fastfetch -h cpu-format
fastfetch -h memory-format
fastfetch -h disk-format
```

### 自定义文本模块

添加自定义文本或分隔线:

```jsonc
{
    "type": "custom",
    "format": "┌─────────── 硬件信息 ───────────┐"
}
```

### Command 模块

执行命令并显示输出:

```jsonc
{
    "type": "command",
    "key": "编辑器",
    "text": "$EDITOR --version | head -1"
}
```

⚠️ **警告**: Command 模块可以执行任意 Shell 命令, 请勿使用来自不可信来源的配置文件。

***

## Logo 自定义

### Logo 配置结构

```jsonc
{
    "logo": {
        "type": "auto",           // Logo 类型
        "source": "arch",         // Logo 源
        "width": 65,              // 宽度(字符)
        "height": 35,             // 高度(字符)
        "padding": {
            "top": 0,
            "left": 0,
            "right": 2
        },
        "color": {
            "1": "blue",
            "2": "cyan"
        }
    }
}
```

### Logo 类型

* `auto` - 自动检测
* `builtin` - 内置 ASCII Logo
* `small` - 小型 Logo
* `file` - 文件 Logo
* `data` - 原始数据
* `none` - 不显示 Logo
* `iterm` - iTerm 图片协议
* `kitty` - Kitty 图片协议
* `sixel` - Sixel 图片协议
* `chafa` - Chafa 图片渲染

### 使用内置 Logo

```bash
# 命令行方式
fastfetch --logo arch

# 配置文件方式
{
    "logo": {
        "type": "builtin",
        "source": "arch"
    }
}
```

### 使用自定义 ASCII 艺术

​

​

创建一个文本文件 `custom-logo.txt`, 使用颜色占位符 `$1` 到 `$9`:

```
$1  ████████
$1  ██$2╔════╝
$1  ██$2║
$1  ██$2║
$1  ╚═╝
```

然后在配置中引用:

```jsonc
{
    "logo": {
        "type": "file",
        "source": "~/.config/fastfetch/custom-logo.txt",
        "color": {
            "1": "blue",
            "2": "yellow"
        }
    }
}
```

或命令行:

```bash
fastfetch -l ~/custom-logo.txt --logo-color-1 blue --logo-color-2 yellow
```

### 使用图片 Logo

#### Linux/macOS

```bash
# 自动选择协议
fastfetch -l ~/Pictures/logo.png

# 指定宽度
fastfetch -l ~/Pictures/logo.png --logo-width 30
```

#### Windows

**Mintty / Wezterm**:

```jsonc
{
    "logo": {
        "type": "iterm",
        "source": "C:/path/to/image.png",
        "width": 30
    }
}
```

**Windows Terminal** (需要 Sixel 支持):

```jsonc
{
    "logo": {
        "type": "sixel",
        "source": "C:/path/to/image.png",
        "width": 30,
        "height": 20
    }
}
```

### Logo 颜色配置

颜色占位符 `$1` 到 `$9` 对应 9 种颜色:

```jsonc
{
    "logo": {
        "color": {
            "1": "red",
            "2": "green",
            "3": "yellow",
            "4": "blue",
            "5": "magenta",
            "6": "cyan",
            "7": "white",
            "8": "bright-red",
            "9": "bright-green"
        }
    }
}
```

支持的颜色名称:

* 基础色: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`
* 亮色: 在颜色名前加 `bright-` 或 `light-`, 如 `bright-red`, `light-blue`

***

## 格式字符串

### 基本语法

格式字符串包含占位符 `{name}` 或 `{index}`:

```
"值: {1} ({2})"
```

使用值 "First" 和 "Second" 会产生: `值: First (Second)`

### 命名标签

使用有意义的名称代替数字:

```bash
fastfetch --title-format '{user-name}@{host-name}'
```

查看支持的标签:

```bash
fastfetch -h title-format
```

### 字符串操作

#### 截断

```bash
# 截断为 5 个字符
{user-name:5}

# 截断并添加省略号
{user-name:-5}
```

#### 填充

```bash
# 左对齐,填充到 20 个字符
{user-name<20}

# 右对齐,填充到 20 个字符
{user-name>20}
```

#### 切片

```bash
# 前 5 个字符
{~0,5}

# 后 5 个字符
{~-5,}

# 从第 3 个到倒数第 2 个
{~2,-2}
```

### 变量引用

#### 环境变量

```bash
{$HOME}        # 环境变量
{$NUM}         # 常量(需在 display.constants 中定义)
```

#### 自动索引

空占位符自动使用递增索引:

```bash
"值: {} ({})"  # 等同于 "值: {1} ({2})"
```

### 条件内容

#### 值存在时显示

```bash
{?2} 第二个值: {2}{?}
```

仅当第 2 个值存在时才显示。

#### 值不存在时显示

```bash
{/2}值不可用{/}
```

仅当第 2 个值不存在时才显示。

#### 组合使用

```bash
{?2}{2}{?}{/2}备用值{/}
```

如果第 2 个值存在则显示它, 否则显示 "备用值"。

### 颜色格式化

使用 `{#}` 添加颜色:

```bash
# ANSI 颜色代码
{#4;35}彩色文本{#}

# 命名颜色
{#underline_magenta}彩色文本{#}

# 重置颜色
{#0} 或 {#}
```

查看支持的颜色:

```bash
fastfetch -h color
```

### 特殊字符

* `{{` - 显示单个 `{`
* `{-}` - 终止格式化

### 示例

```jsonc
{
    "type": "cpu",
    "format": "{#blue}{name}{#} ({cores}核) @ {freq-max} GHz"
},
{
    "type": "memory",
    "format": "{used:8} / {total:8} ({percentage}%)"
},
{
    "type": "disk",
    "format": "{?1}{1}: {/}{2} / {3} ({4}%)"
}
```

***

## 预设配置

### 查看预设

```bash
fastfetch --list-presets
```

### 使用预设

```bash
# Neofetch 风格
fastfetch -c neofetch

# 硬件信息
fastfetch -c hardware

# 软件信息
fastfetch -c software

# 极简风格
fastfetch -c paleofetch

# 所有模块
fastfetch -c all
```

### 常用预设

| 预设名称               | 说明             |
| ------------------ | -------------- |
| `neofetch.jsonc`   | 模仿 Neofetch 风格 |
| `paleofetch.jsonc` | 极简风格           |
| `hardware.jsonc`   | 专注硬件信息         |
| `software.jsonc`   | 专注软件信息         |
| `ci.jsonc`         | 适合 CI 环境       |
| `all.jsonc`        | 显示所有模块         |

### 自定义预设目录

将自定义预设保存到:

```
~/.local/share/fastfetch/presets/
```

然后使用:

```bash
fastfetch -c my-preset
```

***

## 常见问题

### Q: 为什么选择 Fastfetch 而不是 Neofetch?

**A**:

1. Fastfetch 正在积极维护, Neofetch 已停止更新
2. Fastfetch 性能更快
3. 支持更多功能和模块
4. 配置更灵活
5. 数据显示更精确 (如单位统一)
6. 原生支持 Wayland 协议

### Q: 配置文件在哪里?

**A**: 默认位置是 `~/.config/fastfetch/config.jsonc`。Fastfetch 不会自动生成配置文件, 需要手动生成:

```bash
fastfetch --gen-config
```

### Q: Fastfetch 显示本地 IP 地址, 会泄露隐私吗?

**A**: 不会。本地 IP 地址 (10.x.x.x, 172.x.x.x, 192.168.x.x) 只在局域网内有意义, 不涉及隐私问题。如果不想显示, 可以在配置文件中禁用 `localip` 模块。

### Q: 如何隐藏某个模块的键名?

**A**: 将键设置为空格:

```jsonc
{
    "type": "os",
    "key": " "
}
```

### Q: 如何自定义模块输出?

**A**: 使用 `format` 字段:

```jsonc
{
    "type": "gpu",
    "format": "{name}"  // 只显示 GPU 名称
}
```

查看模块支持的格式:

```bash
fastfetch -h gpu-format
```

### Q: 为什么 Logo 颜色显示不正确?

**A**: 确保你的终端支持 256 色或 True Color。可以尝试:

```bash
fastfetch --pipe false
```

强制启用彩色模式。

### Q: Fastfetch 与 p 10 k 冲突, 启动时显示黑白?

**A**: 将 `fastfetch` 命令放在 `p10k-instant-prompt` 初始化之前, 或使用:

```bash
fastfetch --pipe false
```

### Q: 在 Windows 中如何显示图片?

**A**:

* **Mintty/Wezterm**: 支持 iTerm 协议
* **Windows Terminal**: 需要使用 Sixel 格式, 参见 [Logo 自定义](#logo-自定义) 章节

### Q: GPU 显示为 "XXXX Device XXXX (VGA compatible)"?

**A**: 在 Debian/Ubuntu 系统上, 需要更新 PCI ID 数据库:

```bash
# 下载并更新 pci.ids
sudo wget https://pci-ids.ucw.cz/v2.2/pci.ids -O /usr/share/hwdata/pci.ids

# AMD GPU 还需要更新 amdgpu.ids
sudo wget https://gitlab.freedesktop.org/mesa/drm/-/raw/main/data/amdgpu.ids -O /usr/share/libdrm/amdgpu.ids
```

或使用驱动专用检测:

```bash
fastfetch --gpu-driver-specific
```

### Q: Root 身份运行时出现 "Authorization required" 错误?

**A**: 设置 XAUTHORITY 环境变量:

```bash
export XAUTHORITY=$HOME/.Xauthority
```

### Q: 如何让 Fastfetch 在终端启动时自动运行?

**A**: 在 Shell 配置文件中添加:

**Bash** (`~/.bashrc`):

```bash
fastfetch
```

**Zsh** (`~/.zshrc`):

```bash
fastfetch
```

**Fish** (`~/.config/fish/config.fish`):

```fish
fastfetch
```

如果遇到问题, 可以添加延迟:

```bash
sleep 0.2 && fastfetch
```

***

## 高级技巧

### 显示配置

全局显示设置:

```jsonc
{
    "display": {
        "separator": " → ",
        "color": {
            "keys": "blue",
            "title": "cyan"
        },
        "key": {
            "width": 12,
            "type": "both"  // string, icon, both, none
        },
        "bar": {
            "width": 15,
            "char": {
                "elapsed": "█",
                "total": "░"
            },
            "border": true
        },
        "percent": {
            "type": 9,  // 1=数字, 2=条形, 3=两者, 9=彩色数字
            "color": {
                "green": "green",
                "yellow": "yellow",
                "red": "red"
            }
        }
    }
}
```

### 温度颜色配置

```jsonc
{
    "display": {
        "temp": {
            "green": 60,
            "yellow": 80
        }
    }
}
```

* \< 60°C: 绿色
* 60-80°C: 黄色
* 80°C: 红色

### 磁盘模块高级配置

```jsonc
{
    "type": "disk",
    "key": " 磁盘",
    "folders": "/:/home:/boot",
    "format": "{1}: {2} / {3} ({4}%)"
}
```

### 电池温度检测

```bash
fastfetch --battery-temp
```

### GPU 详细信息

```bash
# 使用驱动专用方法
fastfetch --gpu-driver-specific

# 指定检测方法
fastfetch --gpu-detection-method auto
```

### 动态更新

保持 Fastfetch 运行并定时更新:

```bash
fastfetch --dynamic-interval 1000  # 每秒更新
```

### 使用自定义常量

在配置文件中定义常量:

```jsonc
{
    "display": {
        "constants": {
            "MY_TEXT": "自定义文本"
        }
    },
    "modules": [
        {
            "type": "custom",
            "format": "{$MY_TEXT}"
        }
    ]
}
```

### 多模块组合与分组

```jsonc
{
    "modules": [
        {
            "type": "custom",
            "format": "┌─────────── 硬件信息 ───────────┐"
        },
        "host",
        "cpu",
        "gpu",
        "memory",
        {
            "type": "custom",
            "format": "├─────────── 软件信息 ───────────┤"
        },
        "os",
        "kernel",
        "shell",
        "packages",
        {
            "type": "custom",
            "format": "└────────────────────────────────┘"
        }
    ]
}
```

### 使用 FIGlet 生成文本 Logo

```bash
# 安装 pyfiglet 和 jq
pyfiglet -s -f small_slant $(fastfetch -s os --format json | jq -r '.[0].result.name') && fastfetch -l none
```

### 配置文件示例

完整配置示例:

```jsonc
{
    "$schema": "https://github.com/fastfetch-cli/fastfetch/raw/dev/doc/json_schema.json",
    "logo": {
        "type": "auto",
        "source": "arch",
        "padding": {
            "right": 2
        },
        "color": {
            "1": "blue",
            "2": "bright-blue"
        }
    },
    "display": {
        "separator": ": ",
        "color": {
            "keys": "blue",
            "title": "cyan"
        },
        "key": {
            "width": 12
        },
        "bar": {
            "width": 15,
            "char": {
                "elapsed": "■",
                "total": "-"
            }
        }
    },
    "modules": [
        "title",
        "separator",
        {
            "type": "os",
            "key": "OS",
            "format": "{name} {version}"
        },
        {
            "type": "kernel",
            "key": "Kernel"
        },
        {
            "type": "uptime",
            "key": "Uptime"
        },
        {
            "type": "packages",
            "key": "Packages"
        },
        {
            "type": "shell",
            "key": "Shell"
        },
        {
            "type": "terminal",
            "key": "Terminal"
        },
        {
            "type": "cpu",
            "key": "CPU",
            "format": "{name} ({cores}核)"
        },
        {
            "type": "gpu",
            "key": "GPU"
        },
        {
            "type": "memory",
            "key": "Memory",
            "format": "{used} / {total} ({percentage}%)"
        },
        {
            "type": "disk",
            "key": "Disk",
            "folders": "/",
            "format": "{used} / {total} ({percentage}%)"
        },
        "separator",
        "colors"
    ]
}
```

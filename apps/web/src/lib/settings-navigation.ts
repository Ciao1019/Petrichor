import * as React from "react"
import {
  BrainCircuit,
  GitForkIcon,
  IconChartBar,
  IconHistory,
  IconKey,
  IconListDetails,
  IconPackage,
  IconPalette,
  IconPlugConnected,
  IconUserCircle,
  IconUsers,
  IdCard,
  ShieldCheck,
  Sparkles,
} from "@/components/iconimate"
import { dashboardRoutes } from "@/lib/dashboard-routes"

export interface SettingsPage {
  id: string
  label: string
  url: string
  icon: React.ComponentType<{ className?: string }>
  description?: string
  requiredRole?: "SUPER_ADMIN"
}

export interface SettingsSection {
  id: string
  label: string
  description?: string
  requiredRole?: "SUPER_ADMIN"
  pages: SettingsPage[]
}

// 设置按「谁在用、做什么」分组：个人与模型面向所有用户，站点内容与系统运维仅超级管理员可见。
export const settingsSections: SettingsSection[] = [
  {
    id: "personal",
    label: "个人",
    description: "账号信息与使用数据",
    pages: [
      {
        id: "account",
        label: "账号设置",
        url: dashboardRoutes.account,
        icon: IconUserCircle,
        description: "个人资料、密码与登录会话管理",
      },
      {
        id: "metrics",
        label: "数据概览",
        url: dashboardRoutes.metrics,
        icon: IconChartBar,
        description: "随笔、知识库与系统使用数据统计",
      },
    ],
  },
  {
    id: "ai",
    label: "AI 与模型",
    description: "大模型供应商与 Agent 能力调试",
    pages: [
      {
        id: "ai-config",
        label: "模型配置",
        url: dashboardRoutes.aiConfig,
        icon: BrainCircuit,
        description: "AI 大模型提供商与接入密钥配置",
      },
      {
        id: "agent-debug",
        label: "Agent 调试台",
        url: dashboardRoutes.agentDebug,
        icon: Sparkles,
        description: "Agent 交互对话与能力调试控制台",
      },
    ],
  },
  {
    id: "platform",
    label: "开放平台",
    description: "供外部客户端调用知识库的凭据、协议与技能",
    pages: [
      {
        id: "agent-keys",
        label: "API 密钥",
        url: dashboardRoutes.agentKeys,
        icon: IconKey,
        description: "外部调用 API Key 的生成、权限与撤销",
      },
      {
        id: "agent-mcp",
        label: "MCP 服务",
        url: dashboardRoutes.agentMcp,
        icon: IconPlugConnected,
        description: "Model Context Protocol 服务接入配置",
      },
      {
        id: "agent-skill",
        label: "技能包",
        url: dashboardRoutes.agentSkill,
        icon: IconPackage,
        description: "知识库工具与 Agent 扩展技能包",
      },
      {
        id: "agent-logs",
        label: "调用日志",
        url: dashboardRoutes.agentLogs,
        icon: IconHistory,
        description: "外部接口调用历史与统计",
      },
    ],
  },
  {
    id: "site",
    label: "站点内容",
    description: "公开主页的外观与展示内容",
    requiredRole: "SUPER_ADMIN",
    pages: [
      {
        id: "admin-appearance",
        label: "外观设置",
        url: dashboardRoutes.adminAppearance,
        icon: IconPalette,
        description: "前台博客外观、Logo 与展示配置",
        requiredRole: "SUPER_ADMIN",
      },
      {
        id: "admin-about",
        label: "关于我",
        url: dashboardRoutes.adminAbout,
        icon: IdCard,
        description: "公开主页关于页个人履历与简介",
        requiredRole: "SUPER_ADMIN",
      },
      {
        id: "admin-projects",
        label: "开源项目",
        url: dashboardRoutes.adminProjects,
        icon: GitForkIcon,
        description: "展示在个人主页的开源项目列表",
        requiredRole: "SUPER_ADMIN",
      },
      {
        id: "admin-filing",
        label: "备案管理",
        url: dashboardRoutes.adminFiling,
        icon: ShieldCheck,
        description: "网站 ICP 备案与公安网备信息配置",
        requiredRole: "SUPER_ADMIN",
      },
    ],
  },
  {
    id: "ops",
    label: "系统运维",
    description: "用户权限与后台任务排查",
    requiredRole: "SUPER_ADMIN",
    pages: [
      {
        id: "admin-users",
        label: "用户管理",
        url: dashboardRoutes.adminUsers,
        icon: IconUsers,
        description: "系统注册用户与权限状态管理",
        requiredRole: "SUPER_ADMIN",
      },
      {
        id: "admin-document-import-dead-letters",
        label: "视觉导入死信",
        url: dashboardRoutes.adminDocumentImportDeadLetters,
        icon: IconListDetails,
        description: "文档导入任务失败死信排查与重试",
        requiredRole: "SUPER_ADMIN",
      },
    ],
  },
]

export function getSettingsSections(role?: string | null): SettingsSection[] {
  const isSuperAdmin = role === "SUPER_ADMIN"
  return settingsSections
    .filter((section) => !section.requiredRole || (section.requiredRole === "SUPER_ADMIN" && isSuperAdmin))
    .map((section) => ({
      ...section,
      pages: section.pages.filter((page) => !page.requiredRole || (page.requiredRole === "SUPER_ADMIN" && isSuperAdmin)),
    }))
    .filter((section) => section.pages.length > 0)
}

export function getAllSettingsPages(role?: string | null): SettingsPage[] {
  return getSettingsSections(role).flatMap((section) => section.pages)
}

function normalizePath(pathname: string): string {
  const clean = pathname.split("?")[0] ?? ""
  return clean.endsWith("/") && clean.length > 1 ? clean.slice(0, -1) : clean
}

export function getSettingsSection(pathname: string): SettingsSection | undefined {
  const normalized = normalizePath(pathname)
  return settingsSections.find((section) =>
    section.pages.some((page) => normalized === page.url || normalized.startsWith(`${page.url}/`))
  )
}

export function getSettingsPage(pathname: string): SettingsPage | undefined {
  const normalized = normalizePath(pathname)
  for (const section of settingsSections) {
    const page = section.pages.find((p) => normalized === p.url || normalized.startsWith(`${p.url}/`))
    if (page) return page
  }
  return undefined
}

export function isSettingsPath(pathname: string): boolean {
  const normalized = normalizePath(pathname)
  if (normalized === dashboardRoutes.settings || normalized.startsWith(`${dashboardRoutes.settings}/`)) {
    return true
  }
  return settingsSections.some((section) =>
    section.pages.some((page) => normalized === page.url || normalized.startsWith(`${page.url}/`))
  )
}

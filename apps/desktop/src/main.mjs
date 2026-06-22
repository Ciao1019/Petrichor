import { app, BrowserWindow, Menu, shell } from "electron"
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(__dirname, "..")
const workspaceRoot = path.resolve(desktopRoot, "../..")
const webRoot = path.join(workspaceRoot, "apps", "web")

let webProcess = null
let mainWindow = null

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readOrCreateSecret(filePath) {
  try {
    const value = fs.readFileSync(filePath, "utf8").trim()
    if (value.length >= 32) return value
  } catch {
    // Create below.
  }

  const value = crypto.randomBytes(48).toString("base64url")
  fs.writeFileSync(filePath, `${value}\n`, { mode: 0o600 })
  return value
}

async function findOpenPort(startAt = 38740) {
  for (let port = startAt; port < startAt + 80; port += 1) {
    const available = await new Promise((resolve) => {
      const server = net.createServer()
      server.once("error", () => resolve(false))
      server.once("listening", () => {
        server.close(() => resolve(true))
      })
      server.listen(port, "127.0.0.1")
    })

    if (available) return port
  }

  throw new Error("没有找到可用的本地端口")
}

async function waitForServer(url, timeoutMs = 60_000) {
  const startedAt = Date.now()
  let lastError = null

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "manual" })
      if (response.status < 500) return
    } catch (error) {
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, 350))
  }

  throw lastError ?? new Error(`本地服务启动超时：${url}`)
}

function buildDesktopEnv(port) {
  const userData = app.getPath("userData")
  const dataDir = path.join(userData, "data")
  const uploadDir = path.join(userData, "uploads")
  const secretDir = path.join(userData, "secrets")

  ensureDir(dataDir)
  ensureDir(uploadDir)
  ensureDir(secretDir)

  const baseUrl = `http://127.0.0.1:${port}`

  return {
    ...process.env,
    APP_BASE_URL: baseUrl,
    BETTER_AUTH_URL: baseUrl,
    DATABASE_URL: `file:${path.join(dataDir, "petrichor.sqlite")}`,
    NEXT_PUBLIC_APP_URL: baseUrl,
    NEXT_PUBLIC_DESKTOP_MODE: "true",
    PETRICHOR_DESKTOP: "true",
    PETRICHOR_STORAGE_DIR: uploadDir,
    SESSION_SECRET: process.env.SESSION_SECRET || readOrCreateSecret(path.join(secretDir, "session.secret")),
  }
}

function spawnWebServer(port) {
    const command = "pnpm"
    const args = ["--filter", "@petrichor/web", "exec", "next", "dev", "-H", "127.0.0.1", "-p", String(port)]

    webProcess = spawn(command, args, {
        cwd: workspaceRoot,
    env: buildDesktopEnv(port),
    stdio: "inherit",
  })

  webProcess.once("exit", (code, signal) => {
    webProcess = null
    if (!app.isQuitting) {
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
      console.error(`Petrichor 本地服务已退出：${detail}`)
      app.quit()
    }
  })
}

function createMainWindow(baseUrl) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    title: "Petrichor",
    backgroundColor: "#0f0f10",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })

  mainWindow.loadURL(`${baseUrl}/dashboard`)
}

async function boot() {
  Menu.setApplicationMenu(null)

  const port = await findOpenPort()
  const baseUrl = `http://127.0.0.1:${port}`
  spawnWebServer(port)
  await waitForServer(`${baseUrl}/dashboard`)
  createMainWindow(baseUrl)
}

app.once("ready", () => {
  boot().catch((error) => {
    console.error(error)
    app.quit()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && mainWindow) {
    mainWindow.show()
  }
})

app.on("before-quit", () => {
  app.isQuitting = true
  if (webProcess && !webProcess.killed) {
    webProcess.kill()
  }
})

const webRoot = new URL("..", import.meta.url).pathname

const vite = Bun.spawn(["bun", "--bun", "vite"], {
    cwd: webRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, NODE_ENV: "development" },
})

const server = Bun.spawn(["bun", "--watch", "../../server.ts"], {
    cwd: webRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: {
        ...process.env,
        NODE_ENV: "development",
        PETRICHOR_VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
    },
})

function stop() {
    vite.kill()
    server.kill()
}

process.on("SIGINT", stop)
process.on("SIGTERM", stop)

const exitCode = await Promise.race([vite.exited, server.exited])
stop()
process.exit(exitCode)

const apiRoot = new URL("../apps/api", import.meta.url).pathname

const api = Bun.spawn(["go", "run", "./cmd/server"], {
    cwd: apiRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
})

function stop() {
    api.kill()
}

process.on("SIGINT", stop)
process.on("SIGTERM", stop)

process.exit(await api.exited)

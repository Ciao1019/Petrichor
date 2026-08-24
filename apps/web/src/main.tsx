import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "@/client-app"
import "@/styles/globals.css"

const root = document.getElementById("root")
if (!root) {
    throw new Error("缺少前端挂载节点 #root")
}

createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>,
)


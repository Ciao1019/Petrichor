/**
 * Turbopack 构建期 stub：@ast-grep/napi 含原生绑定，无法被打包。
 * Mastra 仅在部分代码分析路径使用；知识库问答主路径不依赖它。
 * 运行时若真正加载到该模块，应走 serverExternalPackages 的 Node require。
 */
export default {}
export const parse = () => {
    throw new Error("@ast-grep/napi is unavailable in this build")
}
export const parseAsync = async () => {
    throw new Error("@ast-grep/napi is unavailable in this build")
}

type ForceModule = typeof import("d3-force-3d")

let forceModulePromise: Promise<ForceModule> | null = null

/** 力导库按需加载，避免低频点群页面占用首屏体积。 */
export function loadForceModule() {
  if (!forceModulePromise) {
    forceModulePromise = import("d3-force-3d").catch((error: unknown) => {
      forceModulePromise = null
      throw error
    })
  }
  return forceModulePromise
}

export function preloadSiteGraphRuntime() {
  return loadForceModule()
}

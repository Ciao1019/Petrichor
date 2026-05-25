export type PublicArticleRenderState = {
  hasArticleData: boolean
  loading: boolean
  error: string | null
  needPassword: boolean
}

export function shouldShowPublicArticleLoadingCard(state: PublicArticleRenderState) {
  return state.loading && !state.hasArticleData && !state.needPassword && !state.error
}

export function shouldRenderPublicArticleBody(state: PublicArticleRenderState) {
  return state.hasArticleData && !state.needPassword && !state.error
}

import { Navigate } from "react-router-dom"

/** 旧知识库目录统一回到全站公开 Wiki。 */
export function PublicWikiKnowledgeBasePage() {
  return <Navigate to="/wiki" replace />
}

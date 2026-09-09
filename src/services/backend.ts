// 后端 API 基地址解析（支持局域网部署）
//
// 解析优先级：
//  1) 构建期环境变量 VITE_BACKEND_URL（如 http://172.28.1.14:3001）——显式指定时使用
//  2) 页面同源：当页面由本后端(express, 端口 3001)托管时，直接用 window.location.origin。
//     这样局域网其他电脑访问 http://172.28.1.14:3001 时，API 请求自动指向同一地址。
//  3) 默认 http://localhost:3001，兼容现有用 vite preview(5182) 本地开发的流程。
export const BACKEND_BASE =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ||
  (typeof window !== 'undefined' && window.location.port === '3001'
    ? window.location.origin
    : 'http://localhost:3001')

// 管理接口令牌（X-Admin-Token）。
// 优先级：构建期烧入的 VITE_ADMIN_TOKEN > 浏览器本地手动设置的 mes-ai-admin-token > 空。
// 局域网部署时，把令牌通过 VITE_ADMIN_TOKEN 在构建时固定进前端包，
// 这样每台设备无需手动输入即可调用受 requireAdmin 保护的接口（上传/删除文档、用户管理）。
export function getAdminToken(): string {
  return (
    (import.meta.env.VITE_ADMIN_TOKEN as string | undefined) ||
    (typeof window !== 'undefined' ? localStorage.getItem('mes-ai-admin-token') : null) ||
    ''
  )
}

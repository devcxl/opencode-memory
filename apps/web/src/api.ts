import axios from 'axios'
import type {
  AskResponse,
  MemoryRecord,
  MemoryType,
  ApiResponse,
  Stats,
  User,
  ApiTokenView,
  SearchResult,
} from './types'

const isLocalViteDev =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') &&
  window.location.port === '3000'

const API_BASE = import.meta.env.VITE_API_URL || (isLocalViteDev ? 'http://localhost:8787' : '')

/**
 * 认证：同源部署时走 GitHub OAuth 会话 Cookie；
 * 本地跨端口开发需 withCredentials，也支持粘贴 API Token（Bearer）。
 */
const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('api_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

export const authUrl = (path: string) => `${API_BASE}${path}`

export const memoryApi = {
  me: () => api.get<ApiResponse<User>>('/api/me'),

  list: (type?: MemoryType, limit = 50, offset = 0) =>
    api.get<ApiResponse<MemoryRecord[]>>('/api/memories', { params: { type, limit, offset } }),

  /** 两桶分层混合搜索（语义 + 关键词） */
  search: (query: string, type?: MemoryType, topK = 8) =>
    api.post<ApiResponse<SearchResult[]>>('/api/memories/search', { query, type, topK }),

  ask: (question: string, topK = 6) => api.post<ApiResponse<AskResponse>>('/api/ask', { question, topK }),

  delete: (id: string) => api.delete<ApiResponse<void>>(`/api/memories/${id}`),

  stats: () => api.get<ApiResponse<Stats>>('/api/stats'),

  digest: () => api.get<ApiResponse<unknown>>('/api/digest'),

  triggerDigest: () => api.post<ApiResponse<unknown>>('/api/digest', {}),

  reindex: () => api.post<ApiResponse<unknown>>('/api/reindex', {}),

  /** API Token 管理 */
  listTokens: () => api.get<ApiResponse<ApiTokenView[]>>('/api/tokens'),

  createToken: (name: string) => api.post<ApiResponse<ApiTokenView & { token: string }>>('/api/tokens', { name }),

  revokeToken: (id: string) => api.delete<ApiResponse<void>>(`/api/tokens/${id}`),
}

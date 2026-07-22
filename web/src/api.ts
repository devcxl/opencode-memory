import axios from 'axios'
import type { AskResponse, Memory, ApiResponse, Stats } from './types'

const isLocalViteDev =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') &&
  window.location.port === '3000'

const API_BASE = import.meta.env.VITE_API_URL || (isLocalViteDev ? 'http://localhost:8787' : '')

const api = axios.create({
  baseURL: API_BASE,
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('jwt_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

export const memoryApi = {
  list: (kind: 'short' | 'long' = 'short', limit = 50, offset = 0) =>
    api.get<ApiResponse<Memory[]>>('/api/memories', { params: { kind, limit, offset } }),

  /** 混合搜索（语义 + 关键词 RRF 融合） */
  search: (query: string, kind?: 'short' | 'long', topK = 5) =>
    api.post<ApiResponse<Memory[]>>('/api/memories/search', { query, kind, topK }),

  /** 纯关键词搜索（降级选项） */
  searchKeyword: (query: string, kind?: 'short' | 'long', limit = 10) =>
    api.post<ApiResponse<Memory[]>>('/api/memories/search/keyword', { query, kind, limit }),

  ask: (question: string, kind?: 'short' | 'long', topK = 6) =>
    api.post<ApiResponse<AskResponse>>('/api/ask', { question, kind, topK }),

  promote: (id: string) =>
    api.post<ApiResponse<void>>(`/api/memories/${id}/promote`),

  delete: (id: string) =>
    api.delete<ApiResponse<void>>(`/api/memories/${id}`),

  stats: () =>
    api.get<ApiResponse<Stats>>('/api/stats'),
}

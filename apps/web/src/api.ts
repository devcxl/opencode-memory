import axios from 'axios'
import type {
  AskResponse,
  Memory,
  ApiResponse,
  Stats,
  Instruction,
  Learning,
  Daily,
} from './types'

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

  /** 结构化记忆：指令 */
  listInstructions: (limit = 50, offset = 0) =>
    api.get<ApiResponse<Instruction[]>>('/api/instructions', { params: { limit, offset } }),
  deleteInstruction: (id: string) =>
    api.delete<ApiResponse<void>>(`/api/instructions/${id}`),

  /** 结构化记忆：学习 */
  listLearnings: (limit = 50, offset = 0) =>
    api.get<ApiResponse<Learning[]>>('/api/learnings', { params: { limit, offset } }),
  deleteLearning: (id: string) =>
    api.delete<ApiResponse<void>>(`/api/learnings/${id}`),

  /** 结构化记忆：每日日志 */
  listDailies: (limit = 50, offset = 0) =>
    api.get<ApiResponse<Daily[]>>('/api/dailies', { params: { limit, offset } }),
  deleteDaily: (id: string) =>
    api.delete<ApiResponse<void>>(`/api/dailies/${id}`),
}

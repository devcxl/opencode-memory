import { useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { Sparkles, ListChecks, CalendarDays, Boxes, Trash2, Loader2, Search } from 'lucide-react'
import { memoryApi } from '../api'
import type { MemoryType, MemoryRecord } from '../types'

const TABS: { key: MemoryType | 'all'; label: string; icon: React.ReactNode }[] = [
  { key: 'all', label: '全部', icon: <Boxes size={16} /> },
  { key: 'fact', label: 'Facts', icon: <Sparkles size={16} /> },
  { key: 'instruction', label: 'Instructions', icon: <ListChecks size={16} /> },
  { key: 'daily', label: 'Dailies', icon: <CalendarDays size={16} /> },
  { key: 'digest', label: 'Digests', icon: <Boxes size={16} /> },
]

const TYPE_COLOR: Record<MemoryType, string> = {
  fact: 'bg-emerald-950/60 text-emerald-400',
  instruction: 'bg-sky-950/60 text-sky-400',
  daily: 'bg-amber-950/60 text-amber-400',
  digest: 'bg-violet-950/60 text-violet-400',
}

export function Memories() {
  const [type, setType] = useState<MemoryType | 'all'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ id: string; title: string; content: string; type: MemoryType; bucket: string; created_at: number }[] | null>(null)
  const queryClient = useQueryClient()

  const { data: records, isLoading } = useQuery({
    queryKey: ['memories', 'list', type],
    queryFn: () => memoryApi.list(type === 'all' ? undefined : type, 100).then(r => r.data.data || []),
  })

  const searchMutation = useMutation({
    mutationFn: (q: string) => memoryApi.search(q, type === 'all' ? undefined : type).then(r => r.data.data || []),
    onSuccess: (results) => setSearchResults(results),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => memoryApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memories'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  const filtered: MemoryRecord[] = (records || []).filter((r) => type === 'all' || r.type === type)

  const fmtDate = (ts: number) => new Date(ts).toLocaleString()

  const renderCard = (item: {
    id: string
    type: MemoryType
    subtype: string
    title: string
    content: string
    project_id: string
    date: string
    created_at: number
    bucket?: string
  }) => (
    <div key={item.id} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex justify-between items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className={`px-1.5 py-0.5 rounded-full ${TYPE_COLOR[item.type]}`}>
            {item.type}{item.subtype ? `/${item.subtype}` : ''}
          </span>
          {item.project_id && (
            <span className="px-1.5 py-0.5 rounded-full bg-neutral-800 text-neutral-400">{item.project_id}</span>
          )}
          {item.date && (
            <span className="px-1.5 py-0.5 rounded-full bg-neutral-800 text-neutral-400">{item.date}</span>
          )}
          {item.bucket && (
            <span className={`px-1.5 py-0.5 rounded-full ${item.bucket === 'full-match' ? 'bg-emerald-950/60 text-emerald-400' : 'bg-neutral-800 text-neutral-400'}`}>
              {item.bucket === 'full-match' ? '精确匹配' : '融合召回'}
            </span>
          )}
        </div>
        {item.title && <p className="mt-2 text-sm font-semibold text-white break-words">{item.title}</p>}
        <p className="mt-1 text-sm text-neutral-300 leading-relaxed whitespace-pre-wrap break-words line-clamp-4">{item.content}</p>
        <div className="mt-2 text-[11px] text-neutral-500">{fmtDate(item.created_at)}</div>
      </div>
      <button
        onClick={() => deleteMutation.mutate(item.id)}
        disabled={deleteMutation.isPending}
        className="p-2 text-neutral-500 hover:text-red-400 hover:bg-neutral-800 rounded-lg transition-colors shrink-0"
        title="删除"
      >
        <Trash2 size={16} />
      </button>
    </div>
  )

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">记忆</h2>
        <p className="mt-1 text-sm text-neutral-500">浏览、搜索和管理你的统一记忆库</p>
      </div>

      {/* 搜索 */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (searchQuery.trim()) searchMutation.mutate(searchQuery.trim())
        }}
        className="flex gap-2"
      >
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="混合搜索（语义 + 关键词），如：华北销售额"
          className="flex-1 bg-neutral-950 border border-neutral-800 rounded-lg px-4 py-2.5 text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-emerald-500"
        />
        <button
          type="submit"
          disabled={!searchQuery.trim() || searchMutation.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-600 px-4 py-2.5 text-sm font-medium text-white transition-colors"
        >
          <Search size={16} />
          <span>搜索</span>
        </button>
      </form>

      {/* 类型 Tab */}
      <div className="flex flex-wrap gap-2 p-1 bg-neutral-900 border border-neutral-800 rounded-xl w-full sm:w-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setType(t.key)
              setSearchResults(null)
            }}
            className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg transition-colors ${
              type === t.key ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300'
            }`}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {isLoading || searchMutation.isPending ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 text-neutral-600 animate-spin" />
        </div>
      ) : searchResults ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-neutral-500">搜索结果 {searchResults.length} 条</p>
            <button onClick={() => setSearchResults(null)} className="text-sm text-emerald-400 hover:text-emerald-300">
              返回列表
            </button>
          </div>
          {searchResults.length === 0 ? (
            <Empty text="没有匹配的记忆" />
          ) : (
            searchResults.map((r) =>
              renderCard({ ...r, subtype: '', project_id: '', date: '', bucket: r.bucket }),
            )
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.length === 0 ? <Empty text="暂无记录" /> : filtered.map((r) => renderCard(r))}
        </div>
      )}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="text-center py-16 text-neutral-500 text-sm">{text}</p>
}

import { useQuery } from '@tanstack/react-query'
import { BookOpen, Sparkles, CalendarDays, Loader2 } from 'lucide-react'
import { memoryApi } from '../api'
import type { Stats } from '../types'

interface OverviewProps {
  stats: Stats | undefined
  isLoading: boolean
}

const statCards = [
  { key: 'learningCount', label: 'Learnings', icon: Sparkles, color: 'text-emerald-400', bg: 'bg-emerald-950/40 border-emerald-800/50' },
  { key: 'instructionCount', label: 'Instructions', icon: BookOpen, color: 'text-sky-400', bg: 'bg-sky-950/40 border-sky-800/50' },
  { key: 'dailyCount', label: 'Dailies', icon: CalendarDays, color: 'text-amber-400', bg: 'bg-amber-950/40 border-amber-800/50' },
] as const

export function Overview({ stats, isLoading }: OverviewProps) {
  const { data: learnings } = useQuery({
    // 与 Memories 页的 ['learnings'] 区分，避免 limit=5 的缓存污染完整列表
    queryKey: ['learnings', 'overview'],
    queryFn: () => memoryApi.listLearnings(5).then(r => r.data.data || []),
  })
  const { data: dailies } = useQuery({
    queryKey: ['dailies', 'overview'],
    queryFn: () => memoryApi.listDailies(5).then(r => r.data.data || []),
  })

  if (isLoading && !stats) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 text-neutral-600 animate-spin" />
      </div>
    )
  }

  const recent = (learnings || []).map(l => ({
    id: l.id,
    title: l.title || 'Learning',
    content: l.content,
    date: l.created_at,
    type: 'learning',
  })).concat(
    (dailies || []).map(d => ({
      id: d.id,
      title: d.date || 'Daily',
      content: d.content,
      date: d.created_at,
      type: 'daily',
    }))
  ).sort((a, b) => b.date - a.date).slice(0, 6)

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-white">概览</h2>
        <p className="mt-1 text-sm text-neutral-500">你的记忆系统概览与最近记录</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {statCards.map((card) => {
          const Icon = card.icon
          const value = stats ? stats[card.key] : 0
          return (
            <div key={card.key} className={`rounded-xl border ${card.bg} p-5`}>
              <div className="flex items-center justify-between">
                <span className={`text-sm font-medium ${card.color}`}>{card.label}</span>
                <Icon className={`w-5 h-5 ${card.color}`} />
              </div>
              <p className="mt-3 text-4xl font-bold text-white">{value}</p>
            </div>
          )
        })}
      </div>

      <section className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider mb-4">最近记录</h3>
        {recent.length === 0 ? (
          <p className="text-center py-10 text-neutral-500 text-sm">暂无记忆记录</p>
        ) : (
          <div className="space-y-3">
            {recent.map((item) => (
              <div key={item.id} className="flex items-start gap-3 rounded-lg bg-neutral-950 border border-neutral-800 px-4 py-3">
                <span
                  className={`mt-1 shrink-0 w-2 h-2 rounded-full ${
                    item.type === 'learning' ? 'bg-emerald-400' : 'bg-amber-400'
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{item.title}</p>
                  <p className="mt-1 text-sm text-neutral-400 line-clamp-2">{item.content}</p>
                </div>
                <span className="shrink-0 text-xs text-neutral-500">
                  {new Date(item.date).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

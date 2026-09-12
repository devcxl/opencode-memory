import { useQuery } from '@tanstack/react-query'
import { BookOpen, Sparkles, CalendarDays, Boxes, Loader2 } from 'lucide-react'
import { memoryApi } from '../api'
import type { Stats } from '../types'

interface OverviewProps {
  stats: Stats | undefined
  isLoading: boolean
}

const statCards = [
  { key: 'fact', label: 'Facts', icon: Sparkles, color: 'text-emerald-400', bg: 'bg-emerald-950/40 border-emerald-800/50' },
  { key: 'instruction', label: 'Instructions', icon: BookOpen, color: 'text-sky-400', bg: 'bg-sky-950/40 border-sky-800/50' },
  { key: 'daily', label: 'Dailies', icon: CalendarDays, color: 'text-amber-400', bg: 'bg-amber-950/40 border-amber-800/50' },
  { key: 'digest', label: 'Digests', icon: Boxes, color: 'text-violet-400', bg: 'bg-violet-950/40 border-violet-800/50' },
] as const

export function Overview({ stats, isLoading }: OverviewProps) {
  const { data: recentRecords } = useQuery({
    queryKey: ['memories', 'overview'],
    queryFn: () => memoryApi.list(undefined, 6).then(r => r.data.data || []),
  })

  if (isLoading && !stats) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 text-neutral-600 animate-spin" />
      </div>
    )
  }

  const undigested = stats?.undigestedCount ?? 0

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-white">概览</h2>
        <p className="mt-1 text-sm text-neutral-500">你的记忆系统概览与最近记录</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {statCards.map((card) => {
          const Icon = card.icon
          const value = stats ? stats.byType[card.key] : 0
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

      {undigested > 0 && (
        <div className="rounded-xl border border-amber-800/50 bg-amber-950/30 px-5 py-4 text-sm text-amber-300">
          有 {undigested} 条 daily 日志待每日总结（每天 04:00 自动汇总为一条事实记忆）。
        </div>
      )}

      <section className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider mb-4">最近记录</h3>
        {(recentRecords || []).length === 0 ? (
          <p className="text-center py-10 text-neutral-500 text-sm">暂无记忆记录</p>
        ) : (
          <div className="space-y-3">
            {(recentRecords || []).map((item) => {
              const dotColor =
                item.type === 'fact' ? 'bg-emerald-400'
                : item.type === 'instruction' ? 'bg-sky-400'
                : item.type === 'digest' ? 'bg-violet-400'
                : 'bg-amber-400'
              return (
                <div key={item.id} className="flex items-start gap-3 rounded-lg bg-neutral-950 border border-neutral-800 px-4 py-3">
                  <span className={`mt-1.5 shrink-0 w-2 h-2 rounded-full ${dotColor}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">
                      {item.title || item.content.slice(0, 60)}
                      <span className="ml-2 text-xs text-neutral-500">{item.type}{item.subtype ? `/${item.subtype}` : ''}</span>
                    </p>
                    <p className="mt-1 text-sm text-neutral-400 line-clamp-2">{item.title ? item.content : ''}</p>
                  </div>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {item.date || new Date(item.created_at).toLocaleDateString()}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

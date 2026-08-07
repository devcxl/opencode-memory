import { useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { Sparkles, ListChecks, CalendarDays, Trash2, Loader2 } from 'lucide-react'
import { memoryApi } from '../api'

type MemoryKind = 'learnings' | 'instructions' | 'dailies'

const TABS: { key: MemoryKind; label: string; icon: React.ReactNode }[] = [
  { key: 'learnings', label: 'Learnings', icon: <Sparkles size={16} /> },
  { key: 'instructions', label: 'Instructions', icon: <ListChecks size={16} /> },
  { key: 'dailies', label: 'Dailies', icon: <CalendarDays size={16} /> },
]

export function Memories() {
  const [kind, setKind] = useState<MemoryKind>('learnings')
  const queryClient = useQueryClient()

  const { data: learnings, isLoading: loadingLearnings } = useQuery({
    queryKey: ['learnings'],
    queryFn: () => memoryApi.listLearnings().then(r => r.data.data || []),
  })
  const { data: instructions, isLoading: loadingInstructions } = useQuery({
    queryKey: ['instructions'],
    queryFn: () => memoryApi.listInstructions().then(r => r.data.data || []),
  })
  const { data: dailies, isLoading: loadingDailies } = useQuery({
    queryKey: ['dailies'],
    queryFn: () => memoryApi.listDailies().then(r => r.data.data || []),
  })

  const deleteMutation = useMutation({
    mutationFn: (input: { kind: MemoryKind; id: string }) => {
      if (input.kind === 'instructions') return memoryApi.deleteInstruction(input.id)
      if (input.kind === 'learnings') return memoryApi.deleteLearning(input.id)
      return memoryApi.deleteDaily(input.id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['learnings'] })
      queryClient.invalidateQueries({ queryKey: ['instructions'] })
      queryClient.invalidateQueries({ queryKey: ['dailies'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  const isLoading =
    (kind === 'learnings' && loadingLearnings) ||
    (kind === 'instructions' && loadingInstructions) ||
    (kind === 'dailies' && loadingDailies)

  const renderDelete = (id: string) => (
    <button
      onClick={() => deleteMutation.mutate({ kind, id })}
      disabled={deleteMutation.isPending}
      className="p-2 text-neutral-500 hover:text-red-400 hover:bg-neutral-800 rounded-lg transition-colors shrink-0"
      title="删除"
    >
      <Trash2 size={16} />
    </button>
  )

  const fmtDate = (ts: number) => new Date(ts).toLocaleDateString()

  const renderList = () => {
    if (kind === 'learnings') {
      const items = learnings || []
      if (items.length === 0) return <Empty text="暂无 Learnings" />
      return (
        <div className="space-y-3">
          {items.map((l) => (
            <div key={l.id} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex justify-between items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="px-1.5 py-0.5 rounded-full bg-emerald-950/60 text-emerald-400">{l.type}</span>
                  <span className="px-1.5 py-0.5 rounded-full bg-neutral-800 text-neutral-400">{l.scope}</span>
                  <span className="px-1.5 py-0.5 rounded-full bg-neutral-800 text-neutral-400">{l.source}</span>
                </div>
                {l.title && <p className="mt-2 text-sm font-semibold text-white break-words">{l.title}</p>}
                <p className="mt-1 text-sm text-neutral-300 leading-relaxed whitespace-pre-wrap break-words line-clamp-4">{l.content}</p>
                <div className="flex flex-wrap gap-3 mt-2 text-[11px] text-neutral-500">
                  <span>{fmtDate(l.created_at)}</span>
                  <span>置信度 {(l.confidence * 100).toFixed(0)}%</span>
                  <span>召回 {l.recall_count}</span>
                  {l.project_id && <span>{l.project_id}</span>}
                </div>
              </div>
              {renderDelete(l.id)}
            </div>
          ))}
        </div>
      )
    }

    if (kind === 'instructions') {
      const items = instructions || []
      if (items.length === 0) return <Empty text="暂无 Instructions" />
      return (
        <div className="space-y-3">
          {items.map((it) => (
            <div key={it.id} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex justify-between items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="px-1.5 py-0.5 rounded-full bg-sky-950/60 text-sky-400">{it.type}</span>
                  <span className="px-1.5 py-0.5 rounded-full bg-neutral-800 text-neutral-400">{it.scope}</span>
                  {it.path_pattern && <span className="px-1.5 py-0.5 rounded-full bg-neutral-800 text-neutral-400">{it.path_pattern}</span>}
                </div>
                {it.title && <p className="mt-2 text-sm font-semibold text-white break-words">{it.title}</p>}
                <p className="mt-1 text-sm text-neutral-300 leading-relaxed whitespace-pre-wrap break-words line-clamp-4">{it.content}</p>
                <div className="flex flex-wrap gap-3 mt-2 text-[11px] text-neutral-500">
                  <span>{fmtDate(it.created_at)}</span>
                  <span>优先级 {it.priority}</span>
                  {it.project_id && <span>{it.project_id}</span>}
                </div>
              </div>
              {renderDelete(it.id)}
            </div>
          ))}
        </div>
      )
    }

    const items = dailies || []
    if (items.length === 0) return <Empty text="暂无 Dailies" />
    return (
      <div className="space-y-3">
        {items.map((d) => (
          <div key={d.id} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex justify-between items-start gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-amber-400">{d.date}</p>
              <p className="mt-1 text-sm text-neutral-300 leading-relaxed whitespace-pre-wrap break-words">{d.content}</p>
              {d.project_id && <p className="mt-2 text-[11px] text-neutral-500">{d.project_id}</p>}
            </div>
            {renderDelete(d.id)}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">记忆</h2>
        <p className="mt-1 text-sm text-neutral-500">浏览和管理你的结构化记忆</p>
      </div>

      <div className="flex gap-2 p-1 bg-neutral-900 border border-neutral-800 rounded-xl w-full sm:w-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setKind(t.key)}
            className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg transition-colors ${
              kind === t.key
                ? 'bg-neutral-800 text-white'
                : 'text-neutral-500 hover:text-neutral-300'
            }`}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 text-neutral-600 animate-spin" />
        </div>
      ) : (
        renderList()
      )}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="text-center py-16 text-neutral-500 text-sm">{text}</p>
}

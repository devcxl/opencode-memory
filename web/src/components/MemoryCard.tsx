import { Trash2, TrendingUp, Calendar, Tag } from 'lucide-react'
import type { Memory } from '../types'

interface MemoryCardProps {
  memory: Memory
  onPromote?: (id: string) => void
  onDelete?: (id: string) => void
}

export function MemoryCard({ memory, onPromote, onDelete }: MemoryCardProps) {
  let tags: string[] = []
  try {
    tags = memory.tags ? JSON.parse(memory.tags) : []
  } catch {
    tags = []
  }
  const date = new Date(memory.created_at).toLocaleDateString()

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 hover:border-neutral-700 transition-colors">
      <div className="flex justify-between items-start gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-neutral-200 text-sm leading-relaxed whitespace-pre-wrap break-words">
            {memory.text}
          </p>

          {memory.snippet && memory.snippet !== memory.text && (
            <div className="mt-3 rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-emerald-400">Matched snippet</p>
              <p className="mt-1 text-sm leading-relaxed text-emerald-100/90 whitespace-pre-wrap break-words">
                {memory.snippet}
              </p>
            </div>
          )}

          {tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {tags.map((tag: string, i: number) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400"
                >
                  <Tag size={10} />
                  {tag}
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 mt-3 text-xs text-neutral-500">
            <Calendar size={12} />
            <span>{date}</span>
            {memory.kind === 'short' && memory.expires_at && (
              <span className="ml-2 text-amber-500">
                Expires {new Date(memory.expires_at).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {memory.kind === 'short' && onPromote && (
            <button
              onClick={() => onPromote(memory.id)}
              className="p-2 text-neutral-500 hover:text-emerald-400 hover:bg-neutral-800 rounded-lg transition-colors"
              title="Promote to long-term"
            >
              <TrendingUp size={16} />
            </button>
          )}
          {onDelete && (
            <button
              onClick={() => onDelete(memory.id)}
              className="p-2 text-neutral-500 hover:text-red-400 hover:bg-neutral-800 rounded-lg transition-colors"
              title="Delete"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

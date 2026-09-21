import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Sparkles, Loader2 } from 'lucide-react'
import { memoryApi } from '../api'
import type { AskResponse } from '../types'

export function Ask() {
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState<AskResponse | null>(null)

  const askMutation = useMutation({
    mutationFn: (q: string) => memoryApi.ask(q).then(r => r.data.data),
    onSuccess: (data) => {
      setResult(data || null)
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!question.trim() || askMutation.isPending) return
    askMutation.mutate(question)
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">AI 问答</h2>
        <p className="mt-1 text-sm text-neutral-500">基于你的记忆进行问答，回答附带引用来源</p>
      </div>

      <section className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-emerald-950/40 border border-emerald-900/50">
            <Sparkles className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="text-sm text-neutral-400">
            输入一个问题，系统会从你的结构化记忆中检索相关内容并生成带引用的回答。
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a question about your memories..."
            className="w-full min-h-[96px] resize-none rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3 text-white placeholder-neutral-600 focus:outline-none focus:border-emerald-500"
          />
          <div className="flex items-center justify-end gap-3">
            <button
              type="submit"
              disabled={!question.trim() || askMutation.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-600"
            >
              {askMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{askMutation.isPending ? 'Thinking...' : 'Ask AI'}</span>
            </button>
          </div>
        </form>

        {askMutation.isError && (
          <p className="text-sm text-red-400">问答失败，请稍后重试。</p>
        )}

        {result && (
          <div className="space-y-4 rounded-xl border border-neutral-800 bg-neutral-950/70 p-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-emerald-400">回答</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-neutral-200">
                {result.answer}
              </p>
            </div>

            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-emerald-400">引用来源</p>
              <div className="mt-3 space-y-3">
                {result.citations.length === 0 ? (
                  <p className="text-sm text-neutral-500">未返回可用引用。</p>
                ) : (
                  result.citations.map((citation) => (
                    <div key={citation.memoryId} className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                        <span className="px-1.5 py-0.5 rounded-full bg-neutral-800 text-neutral-400">
                          {citation.type}
                        </span>
                        <span>Score: {(citation.score * 100).toFixed(0)}%</span>
                        <span>{new Date(citation.createdAt).toLocaleString()}</span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-neutral-200">
                        {citation.text}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

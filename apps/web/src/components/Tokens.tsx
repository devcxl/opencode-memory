import { useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { KeyRound, Plus, Trash2, Loader2, Copy, Check, RefreshCw, Boxes } from 'lucide-react'
import { memoryApi } from '../api'

/** API Token 管理页：生成/查看/吊销，供插件与 MCP 客户端使用 */
export function Tokens() {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const { data: tokens, isLoading } = useQuery({
    queryKey: ['tokens'],
    queryFn: () => memoryApi.listTokens().then(r => r.data.data || []),
  })

  const createMutation = useMutation({
    mutationFn: () => memoryApi.createToken(name.trim()).then(r => r.data.data),
    onSuccess: (data) => {
      setCreatedToken(data?.token || null)
      setName('')
      queryClient.invalidateQueries({ queryKey: ['tokens'] })
    },
  })

  const revokeMutation = useMutation({
    mutationFn: (id: string) => memoryApi.revokeToken(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tokens'] }),
  })

  const maintenanceMutation = useMutation({
    mutationFn: (action: 'digest' | 'reindex') =>
      action === 'digest' ? memoryApi.triggerDigest() : memoryApi.reindex(),
  })

  const copyToken = async () => {
    if (!createdToken) return
    await navigator.clipboard.writeText(createdToken)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-white">API Token</h2>
        <p className="mt-1 text-sm text-neutral-500">
          为 OpenCode 插件或 MCP 客户端生成访问凭证。Token 明文只在创建时显示一次，请妥善保存。
        </p>
      </div>

      {/* 创建 */}
      <section className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-4">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) createMutation.mutate()
          }}
          className="flex gap-2"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Token 名称，如：我的笔记本 / MCP-Claude"
            className="flex-1 bg-neutral-950 border border-neutral-800 rounded-lg px-4 py-2.5 text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-emerald-500"
          />
          <button
            type="submit"
            disabled={!name.trim() || createMutation.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-600 px-4 py-2.5 text-sm font-medium text-white transition-colors"
          >
            <Plus size={16} />
            <span>生成 Token</span>
          </button>
        </form>

        {createMutation.isError && <p className="text-sm text-red-400">创建失败，请重试。</p>}

        {createdToken && (
          <div className="rounded-lg border border-emerald-800/50 bg-emerald-950/30 p-4 space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-emerald-400">请立即复制（仅显示一次）</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm text-neutral-200">
                {createdToken}
              </code>
              <button
                onClick={copyToken}
                className="p-2 text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-lg transition-colors shrink-0"
                title="复制"
              >
                {copied ? <Check size={16} className="text-emerald-400" /> : <Copy size={16} />}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 列表 */}
      <section className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider mb-4">已有 Token</h3>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-6 h-6 text-neutral-600 animate-spin" />
          </div>
        ) : (tokens || []).length === 0 ? (
          <p className="text-center py-8 text-neutral-500 text-sm">还没有 Token</p>
        ) : (
          <div className="space-y-3">
            {(tokens || []).map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-4 rounded-lg bg-neutral-950 border border-neutral-800 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white">{t.name}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    <code>{t.prefix}…</code>
                    <span className="mx-2">·</span>
                    创建于 {new Date(t.created_at).toLocaleDateString()}
                    {t.last_used_at && (
                      <>
                        <span className="mx-2">·</span>
                        最近使用 {new Date(t.last_used_at).toLocaleString()}
                      </>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => revokeMutation.mutate(t.id)}
                  disabled={revokeMutation.isPending}
                  className="p-2 text-neutral-500 hover:text-red-400 hover:bg-neutral-800 rounded-lg transition-colors shrink-0"
                  title="吊销"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 运维操作 */}
      <section className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider mb-4">维护</h3>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => maintenanceMutation.mutate('digest')}
            disabled={maintenanceMutation.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 px-4 py-2.5 text-sm font-medium text-white transition-colors disabled:opacity-50"
          >
            <Boxes size={16} />
            <span>手动触发昨日总结</span>
          </button>
          <button
            onClick={() => maintenanceMutation.mutate('reindex')}
            disabled={maintenanceMutation.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 px-4 py-2.5 text-sm font-medium text-white transition-colors disabled:opacity-50"
          >
            <RefreshCw size={16} />
            <span>重建向量索引</span>
          </button>
          {maintenanceMutation.isSuccess && <span className="inline-flex items-center gap-2 text-sm text-emerald-400"><KeyRound size={14} /> 已触发，可在日志查看结果</span>}
        </div>
      </section>
    </div>
  )
}

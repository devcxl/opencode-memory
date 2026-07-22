import { useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { Search, Brain, Clock, LogOut, Loader2, Settings, Sparkles, Type } from 'lucide-react'
import { memoryApi } from './api'
import { MemoryCard } from './components/MemoryCard'
import type { AskResponse, Memory } from './types'

function App() {
  const [token, setToken] = useState<string>(() => localStorage.getItem('jwt_token') || '')
  const [tokenInput, setTokenInput] = useState('')
  const [activeTab, setActiveTab] = useState<'short' | 'long'>('short')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Memory[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchMode, setSearchMode] = useState<'hybrid' | 'keyword'>('hybrid')
  const [question, setQuestion] = useState('')
  const [askResult, setAskResult] = useState<AskResponse | null>(null)

  const queryClient = useQueryClient()
  const hasToken = Boolean(token)

  const { data: statsData } = useQuery({
    queryKey: ['stats'],
    queryFn: () => memoryApi.stats().then(r => r.data.data),
    refetchInterval: 30000,
    enabled: hasToken,
  })

  const { data: memories, isLoading } = useQuery({
    queryKey: ['memories', activeTab],
    queryFn: () => memoryApi.list(activeTab).then(r => r.data.data || []),
    enabled: hasToken,
  })

  const promoteMutation = useMutation({
    mutationFn: (id: string) => memoryApi.promote(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memories'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  const askMutation = useMutation({
    mutationFn: (input: { question: string; kind: 'short' | 'long' }) =>
      memoryApi.ask(input.question, input.kind).then(r => r.data.data),
    onSuccess: (data) => {
      setAskResult(data || null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => memoryApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memories'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  if (!token) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <Brain className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-white">Memory Server</h1>
            <p className="text-neutral-500 mt-2">Enter your JWT token to continue</p>
          </div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Bearer <your-token>"
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-4 py-3 text-white placeholder-neutral-600 focus:outline-none focus:border-emerald-500"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && tokenInput) {
                  const t = tokenInput.startsWith('Bearer ') ? tokenInput.slice(7) : tokenInput
                  localStorage.setItem('jwt_token', t)
                  setToken(t)
                }
              }}
            />
            <button
              onClick={() => {
                const t = tokenInput.startsWith('Bearer ') ? tokenInput.slice(7) : tokenInput
                localStorage.setItem('jwt_token', t)
                setToken(t)
              }}
              disabled={!tokenInput}
              className="w-full mt-4 bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-600 text-white font-medium py-3 rounded-lg transition-colors"
            >
              Connect
            </button>
          </div>
        </div>
      </div>
    )
  }

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!searchQuery.trim()) {
      setSearchResults([])
      return
    }
    setIsSearching(true)
    try {
      const res = searchMode === 'hybrid'
        ? await memoryApi.search(searchQuery, activeTab)
        : await memoryApi.searchKeyword(searchQuery, activeTab)
      setSearchResults(res.data.data || [])
    } finally {
      setIsSearching(false)
    }
  }

  const handleAsk = (e: React.FormEvent) => {
    e.preventDefault()
    if (!question.trim()) return
    askMutation.mutate({ question, kind: activeTab })
  }

  const displayMemories = searchQuery ? searchResults : (memories || [])

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <header className="border-b border-neutral-800 bg-neutral-900/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Brain className="w-8 h-8 text-emerald-400" />
            <h1 className="text-xl font-bold">Memory Server</h1>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => {
                localStorage.removeItem('jwt_token')
                setToken('')
                setSearchResults([])
                setSearchQuery('')
              }}
              className="flex items-center gap-2 text-neutral-400 hover:text-white transition-colors"
            >
              <LogOut size={18} />
              <span className="text-sm hidden sm:inline">Disconnect</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div className="lg:col-span-3 space-y-6">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <form onSubmit={handleSearch} className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜索记忆..."
                    className="w-full bg-neutral-900 border border-neutral-800 rounded-xl pl-10 pr-10 py-3 text-white placeholder-neutral-600 focus:outline-none focus:border-emerald-500 transition-colors"
                  />
                  {isSearching && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500 animate-spin" />
                  )}
                </form>
              </div>
              <button
                type="button"
                onClick={() => setSearchMode(searchMode === 'hybrid' ? 'keyword' : 'hybrid')}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                  searchMode === 'hybrid'
                    ? 'bg-emerald-950/40 border-emerald-800/50 text-emerald-400'
                    : 'bg-neutral-900 border-neutral-800 text-neutral-500 hover:border-neutral-700'
                }`}
                title={searchMode === 'hybrid' ? 'Switch to keyword-only search' : 'Switch to hybrid search (recommended)'}
              >
                {searchMode === 'hybrid' ? (
                  <><Sparkles size={14} /> Hybrid</>
                ) : (
                  <><Type size={14} /> Keyword</>
                )}
              </button>
            </div>

            <section className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-emerald-950/40 border border-emerald-900/50">
                  <Sparkles className="w-4 h-4 text-emerald-400" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white">AI Q&A</h2>
                  <p className="mt-1 text-sm text-neutral-400">
                    Memories are created through MCP. Ask a question here to get a grounded answer with memory citations.
                  </p>
                </div>
              </div>

              <form onSubmit={handleAsk} className="space-y-3">
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Ask a question about your indexed memories..."
                  className="w-full min-h-[96px] resize-none rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3 text-white placeholder-neutral-600 focus:outline-none focus:border-emerald-500"
                />
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-neutral-500">
                    Retrieval uses memories from the current {activeTab === 'short' ? 'short-term' : 'long-term'} tab.
                  </p>
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

              {askResult && (
                <div className="space-y-4 rounded-xl border border-neutral-800 bg-neutral-950/70 p-4">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-emerald-400">Answer</p>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-neutral-200">
                      {askResult.answer}
                    </p>
                  </div>

                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-emerald-400">Citations</p>
                    <div className="mt-3 space-y-3">
                      {askResult.citations.length === 0 ? (
                          <p className="text-sm text-neutral-500">未返回可用引用。</p>
                      ) : (
                        askResult.citations.map((citation) => (
                          <div key={citation.memoryId} className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-3">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                              <span>{citation.kind === 'short' ? 'Short-term' : 'Long-term'}</span>
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

            <div className="flex gap-2 p-1 bg-neutral-900 border border-neutral-800 rounded-xl">
              <button
                onClick={() => { setActiveTab('short'); setSearchQuery(''); setSearchResults([]) }}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg transition-colors ${
                  activeTab === 'short' && !searchQuery
                    ? 'bg-neutral-800 text-white'
                    : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                <Clock size={18} />
                <span>Short-term</span>
              </button>
              <button
                onClick={() => { setActiveTab('long'); setSearchQuery(''); setSearchResults([]) }}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg transition-colors ${
                  activeTab === 'long' && !searchQuery
                    ? 'bg-neutral-800 text-white'
                    : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                <Brain size={18} />
                <span>Long-term</span>
              </button>
            </div>

            <div className="space-y-3">
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 text-neutral-600 animate-spin" />
                </div>
              ) : displayMemories.length === 0 ? (
                <div className="text-center py-12 text-neutral-500">
                  {searchQuery ? 'No memories found' : 'No memories yet'}
                </div>
              ) : (
                displayMemories.map((memory) => (
                  <MemoryCard
                    key={memory.id}
                    memory={memory}
                    onPromote={memory.kind === 'short' ? (id) => promoteMutation.mutate(id) : undefined}
                    onDelete={(id) => deleteMutation.mutate(id)}
                  />
                ))
              )}
            </div>
          </div>

          <aside className="space-y-6">
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                <Settings size={14} />
                Stats
              </h2>
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-neutral-400">Short-term</span>
                  <span className="text-xl font-bold text-amber-400">{statsData?.shortCount || 0}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-neutral-400">Long-term</span>
                  <span className="text-xl font-bold text-emerald-400">{statsData?.longCount || 0}</span>
                </div>
              </div>
            </div>

            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider mb-3">About</h2>
              <p className="text-sm text-neutral-500 leading-relaxed">
                Cloudflare Memory Server with MCP support, semantic search, and automatic daily consolidation.
              </p>
            </div>
          </aside>
        </div>
      </main>
    </div>
  )
}

export default App

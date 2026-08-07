import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Brain, LayoutDashboard, BookOpen, MessageSquare, LogOut, Loader2 } from 'lucide-react'
import { memoryApi } from './api'
import { Overview } from './components/Overview'
import { Memories } from './components/Memories'
import { Ask } from './components/Ask'

type Page = 'overview' | 'memories' | 'ask'

const NAV: { key: Page; label: string; icon: React.ReactNode }[] = [
  { key: 'overview', label: '总览', icon: <LayoutDashboard size={18} /> },
  { key: 'memories', label: '记忆', icon: <BookOpen size={18} /> },
  { key: 'ask', label: 'AI 问答', icon: <MessageSquare size={18} /> },
]

function App() {
  const [token, setToken] = useState<string>(() => localStorage.getItem('jwt_token') || '')
  const [tokenInput, setTokenInput] = useState('')
  const [page, setPage] = useState<Page>('overview')

  const hasToken = Boolean(token)

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['stats'],
    queryFn: () => memoryApi.stats().then(r => r.data.data),
    refetchInterval: 30000,
    enabled: hasToken,
  })

  if (!token) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <Brain className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-white">Memory Server</h1>
            <p className="text-neutral-500 mt-2">请输入 JWT token 继续</p>
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
              连接
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <header className="border-b border-neutral-800 bg-neutral-900/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Brain className="w-7 h-7 text-emerald-400" />
            <span className="text-lg font-bold">Memory Server</span>
          </div>

          <nav className="flex items-center gap-1 bg-neutral-900 border border-neutral-800 rounded-xl p-1">
            {NAV.map((item) => {
              return (
                <button
                  key={item.key}
                  onClick={() => setPage(item.key)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    page === item.key
                      ? 'bg-neutral-800 text-white'
                      : 'text-neutral-400 hover:text-white'
                  }`}
                >
                  {item.icon}
                  <span className="hidden sm:inline">{item.label}</span>
                </button>
              )
            })}
          </nav>

          <button
            onClick={() => {
              localStorage.removeItem('jwt_token')
              setToken('')
            }}
            className="flex items-center gap-2 text-neutral-400 hover:text-white transition-colors"
          >
            <LogOut size={18} />
            <span className="text-sm hidden sm:inline">退出</span>
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {statsLoading && !stats && page === 'overview' ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-8 h-8 text-neutral-600 animate-spin" />
          </div>
        ) : (
          <>
            {page === 'overview' && <Overview stats={stats} isLoading={statsLoading} />}
            {page === 'memories' && <Memories />}
            {page === 'ask' && <Ask />}
          </>
        )}
      </main>
    </div>
  )
}

export default App

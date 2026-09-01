import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Brain, LayoutDashboard, BookOpen, MessageSquare, KeyRound, LogOut, Loader2, Github } from 'lucide-react'
import { memoryApi, authUrl } from './api'
import { Overview } from './components/Overview'
import { Memories } from './components/Memories'
import { Ask } from './components/Ask'
import { Tokens } from './components/Tokens'

type Page = 'overview' | 'memories' | 'ask' | 'tokens'

const NAV: { key: Page; label: string; icon: React.ReactNode }[] = [
  { key: 'overview', label: '总览', icon: <LayoutDashboard size={18} /> },
  { key: 'memories', label: '记忆', icon: <BookOpen size={18} /> },
  { key: 'ask', label: 'AI 问答', icon: <MessageSquare size={18} /> },
  { key: 'tokens', label: 'API Token', icon: <KeyRound size={18} /> },
]

function App() {
  const [page, setPage] = useState<Page>('overview')

  // 会话状态：Cookie 认证（同源）或 Bearer Token（本地开发）
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => memoryApi.me().then(r => r.data.data),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['stats'],
    queryFn: () => memoryApi.stats().then(r => r.data.data),
    refetchInterval: 30000,
    enabled: Boolean(meQuery.data),
  })

  if (meQuery.isLoading) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-neutral-600 animate-spin" />
      </div>
    )
  }

  if (meQuery.isError || !meQuery.data) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center p-4">
        <div className="w-full max-w-md text-center">
          <Brain className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white">Memory Server</h1>
          <p className="text-neutral-500 mt-2 mb-8">使用 GitHub 账号登录以管理你的记忆</p>
          <a
            href={authUrl('/auth/github/login')}
            className="inline-flex items-center gap-3 bg-white hover:bg-neutral-200 text-black font-medium px-6 py-3 rounded-lg transition-colors"
          >
            <Github size={20} />
            <span>Sign in with GitHub</span>
          </a>
        </div>
      </div>
    )
  }

  const user = meQuery.data

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

          <div className="flex items-center gap-3">
            {user.avatar_url && (
              <img src={user.avatar_url} alt={user.login} className="w-7 h-7 rounded-full border border-neutral-700" />
            )}
            <span className="text-sm text-neutral-400 hidden md:inline">{user.login}</span>
            <a
              href={authUrl('/auth/logout')}
              className="flex items-center gap-2 text-neutral-400 hover:text-white transition-colors"
              title="退出登录"
            >
              <LogOut size={18} />
              <span className="text-sm hidden sm:inline">退出</span>
            </a>
          </div>
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
            {page === 'tokens' && <Tokens />}
          </>
        )}
      </main>
    </div>
  )
}

export default App

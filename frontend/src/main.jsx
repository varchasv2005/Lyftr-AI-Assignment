import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowDown, ArrowUp, Check, ChevronDown, CircleHelp, Command, Copy, Menu, Plus, Sparkles, X } from 'lucide-react'
import './style.css'

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')
const suggestions = [
  { icon: '✳', title: 'Plan a weekend getaway', prompt: 'Help me plan a relaxing weekend getaway.' },
  { icon: '⌘', title: 'Explain something simply', prompt: 'Explain a complex topic in simple terms.' },
  { icon: '✎', title: 'Write with me', prompt: 'Help me write a thoughtful, polished message.' },
  { icon: '◌', title: 'Help me brainstorm', prompt: 'Let’s brainstorm a few fresh ideas together.' },
]

function makeId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  } catch { /* Use the fallback in restricted browser contexts. */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function makeSession() { return `s-${makeId().slice(0, 8)}` }

function displayText(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(displayText).filter(Boolean).join('\n')
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    try { return JSON.stringify(value) } catch { return '[Unrenderable response]' }
  }
  return ''
}

class AppErrorBoundary extends React.Component {
  state = { failed: false, message: '', stack: '' }

  static getDerivedStateFromError(error) {
    return {
      failed: true,
      message: error instanceof Error ? error.message : 'Unknown display error',
      stack: error instanceof Error && typeof error.stack === 'string' ? error.stack : '',
    }
  }

  render() {
    if (this.state.failed) {
      return <main className="fatal-error" role="alert">
        <div className="fatal-error-card">
          <div className="brand-mark"><Sparkles size={17} strokeWidth={1.7} /></div>
          <h1>SARA hit a display error</h1>
          <p>Your conversation is still in this browser session. Reload SARA to continue.</p>
          {this.state.message && <code className="fatal-error-detail">{this.state.message}</code>}
          {this.state.stack && <details className="fatal-error-stack"><summary>Diagnostic details</summary><pre>{this.state.stack}</pre></details>}
          <button onClick={() => window.location.reload()}>Reload SARA</button>
        </div>
      </main>
    }
    return this.props.children
  }
}

function App() {
  const [sessionId, setSessionId] = useState(makeSession)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [promptOpen, setPromptOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [health, setHealth] = useState('checking')
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const endRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    fetch(`${API}/health`).then(r => r.ok ? r.json() : Promise.reject()).then(() => setHealth('online')).catch(() => setHealth('offline'))
  }, [])
  useEffect(() => {
    const target = endRef.current
    if (typeof target?.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [messages, busy])

  function newChat() {
    setSessionId(makeSession()); setMessages([]); setInput(''); setMenuOpen(false); inputRef.current?.focus()
  }

  async function sendMessage(text = input) {
    const message = text.trim()
    if (!message || busy) return
    setInput(''); setBusy(true)
    const userMessage = { role: 'user', content: message, id: makeId() }
    setMessages(old => [...old, userMessage])
    try {
      const response = await fetch(`${API}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, message, ...(systemPrompt.trim() ? { system_prompt: systemPrompt.trim() } : {}) }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(displayText(data.detail) || `Request failed (${response.status})`)
      const reply = displayText(data.reply)
      if (!reply) throw new Error('The provider returned an empty reply. Check the provider model configuration.')
      const rawMetadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {}
      const metadata = {
        resolution_source: displayText(rawMetadata.resolution_source),
        model: displayText(rawMetadata.model),
        latency_ms: displayText(rawMetadata.latency_ms),
        input_tokens: displayText(rawMetadata.input_tokens),
        output_tokens: displayText(rawMetadata.output_tokens),
      }
      setMessages(old => [...old, { role: 'assistant', content: reply, metadata, id: makeId() }])
    } catch (error) {
      const reason = error instanceof Error ? error.message : displayText(error)
      setMessages(old => [...old, { role: 'error', content: displayText(reason) || 'SARA could not connect right now. Please try again.', id: makeId() }])
    } finally { setBusy(false); inputRef.current?.focus() }
  }

  async function copyConversation() {
    await navigator.clipboard.writeText(messages.map(m => `${m.role === 'assistant' ? 'SARA' : m.role === 'user' ? 'You' : 'Notice'}: ${m.content}`).join('\n\n'))
    setCopied(true); setTimeout(() => setCopied(false), 1600)
  }

  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="brand-row"><div className="brand-mark"><Sparkles size={17} strokeWidth={1.7} /></div><span className="brand-name">sara</span><button className="icon-button mobile-menu-close" aria-label="Close menu" onClick={() => setMenuOpen(false)}><X size={17}/></button></div>
      <button className="new-chat" onClick={newChat}><Plus size={16}/><span>New chat</span><kbd><Command size={11}/> K</kbd></button>
      <div className="side-label">YOUR ASSISTANT</div>
      <div className="assistant-card"><div className="assistant-avatar"><Sparkles size={15}/></div><div><div className="assistant-title">SARA</div><div className="assistant-subtitle">Smart Adaptive Response Assistant</div></div><span className={`status-dot ${health}`} /></div>
      <div className="side-spacer" />
      <div className="sidebar-bottom"><div className="online-indicator"><span className={`pulse ${health}`} />{health === 'online' ? 'All systems operational' : health === 'checking' ? 'Checking connection…' : 'Backend unavailable'}</div><div className="profile-row"><div className="profile-avatar">S</div><div className="profile-copy"><strong>SARA workspace</strong><span>Personal</span></div><ChevronDown size={15} className="profile-chevron" /></div></div>
    </aside>
    {menuOpen && <button aria-label="Close navigation" className="mobile-scrim" onClick={() => setMenuOpen(false)} />}
    <main className="main-panel">
      <header className="topbar"><button className="icon-button mobile-menu-open" aria-label="Open menu" onClick={() => setMenuOpen(true)}><Menu size={19}/></button><div className="crumb"><span>Workspace</span><span className="crumb-sep">/</span><strong>New conversation</strong><ChevronDown size={14} /></div><div className="top-actions"><button className="top-action" onClick={() => setPromptOpen(v => !v)}><span className="prompt-glyph">✳</span><span>System prompt</span><span className={`toggle ${promptOpen ? 'toggle-on' : ''}`}><i/></span></button><button className="icon-button help-button" aria-label="Help" title="SARA is powered by a resilient, multi-key AI backend"><CircleHelp size={17}/></button></div></header>
      <section className={`conversation ${messages.length ? 'conversation-active' : ''}`}>
        {messages.length === 0 ? <div className="welcome-wrap"><div className="welcome-orb"><div className="orb-ring ring-one"/><div className="orb-ring ring-two"/><div className="orb-center"><Sparkles size={23} strokeWidth={1.5}/></div><i className="orb-star star-one">✳</i><i className="orb-star star-two">✦</i><i className="orb-star star-three">·</i></div><div className="eyebrow"><span/> YOUR THOUGHTFUL AI COMPANION</div><h1>Good to see you.<br/><span>What’s on your mind?</span></h1><p className="welcome-copy">I’m SARA, your Smart Adaptive Response Assistant.<br className="desktop-break"/> Bring me a question, a challenge, or a spark of an idea.</p><div className="suggestions">{suggestions.map((s, i) => <button key={s.title} className="suggestion" style={{'--i': i}} onClick={() => sendMessage(s.prompt)}><span className="suggestion-icon">{s.icon}</span><span>{s.title}</span><ArrowUp size={14} className="suggestion-arrow"/></button>)}</div></div> : <div className="message-list">{messages.map(m => m.role === 'user' ? <div className="user-message" key={m.id}><div>{m.content}</div></div> : m.role === 'error' ? <div className="error-message" key={m.id}><div className="error-icon">!</div><div><strong>Something went wrong</strong><p>{m.content}</p><button onClick={() => { setInput(messages.filter(x => x.role === 'user').at(-1)?.content || ''); inputRef.current?.focus() }}>Try again</button></div></div> : <article className="assistant-message" data-testid="assistant-message" key={m.id}><div className="reply-avatar"><Sparkles size={15}/></div><div className="reply-body"><div className="reply-heading"><strong>SARA</strong><span className="reply-timestamp">just now</span></div><div className="reply-text">{m.content}</div><div className="metadata-row"><span className={`source-chip ${m.metadata?.resolution_source === 'LLM_CACHE' ? 'cached' : ''}`} data-testid="meta-source"><i/>{m.metadata?.resolution_source}</span><span className="meta-chip"><span className="meta-key">model</span><span data-testid="meta-model">{m.metadata?.model}</span></span><span className="meta-chip"><span className="meta-key">time</span><span data-testid="meta-latency">{m.metadata?.latency_ms} ms</span></span><span className="meta-chip"><span className="meta-key">in</span><span data-testid="meta-input-tokens">{m.metadata?.input_tokens}</span></span><span className="meta-chip"><span className="meta-key">out</span><span data-testid="meta-output-tokens">{m.metadata?.output_tokens}</span></span></div></div></article>)}{busy && <div className="thinking-row"><div className="reply-avatar thinking-avatar"><Sparkles size={15}/></div><span>SARA is thinking</span><span className="thinking-dots"><i/><i/><i/></span></div>}<div ref={endRef}/></div>}
      </section>
      <div className="composer-area"><div className="composer-wrap"><form className="composer" onSubmit={e => { e.preventDefault(); sendMessage() }}><textarea ref={inputRef} data-testid="chat-input" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if(e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }} placeholder="Message SARA…" rows={1} disabled={busy} aria-label="Message SARA"/><div className="composer-footer"><div className="composer-hint"><span className="sparkle-small">✳</span> Thoughtful answers, built around you</div><button data-testid="send-button" className={`send-button ${input.trim() && !busy ? 'send-ready' : ''}`} type="submit" disabled={!input.trim() || busy} aria-label="Send message"><ArrowUp size={17}/></button></div></form><div className="composer-note">SARA can make mistakes. Check important information.</div></div></div>
      {promptOpen && <div className="prompt-popover"><div className="prompt-popover-head"><div><strong>Session instructions</strong><span>Shape how SARA responds in this chat</span></div><button className="icon-button" aria-label="Close system prompt" onClick={() => setPromptOpen(false)}><X size={16}/></button></div><textarea data-testid="system-prompt-input" value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} placeholder="e.g. Keep answers concise and use a warm tone…"/><div className="prompt-foot"><span>Only applies to this conversation</span><button onClick={() => setPromptOpen(false)}>Done <Check size={13}/></button></div></div>}
      <button className="copy-chat" onClick={copyConversation} aria-label="Copy conversation" title="Copy conversation"><Copy size={14}/>{copied ? 'Copied' : 'Copy chat'}</button>
    </main>
  </div>
}

createRoot(document.getElementById('root')).render(<React.StrictMode><AppErrorBoundary><App/></AppErrorBoundary></React.StrictMode>)

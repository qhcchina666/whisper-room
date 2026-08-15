import { useState, useEffect, useRef } from 'react'
import { joinRoom, selfId } from '@trystero-p2p/torrent'
import type { Action, HelloPayload, TextPayload, FilePayload, FileAcceptPayload, LocalMsg } from '../types'
import { peerColor } from '../utils/peers'
import { themeTokens } from '../utils/theme'
import { MessageRow } from './MessageRow'
import { QRModal } from './QRModal'

interface Props {
  myName: string
  roomId: string
  dark: boolean
  onLeave: () => void
  onToggleTheme: () => void
}

// Prefix binary payload with [4-byte id-length][id bytes][file data]
// so the receiver can correlate the blob to the file metadata.
function encodeFileChunk(id: string, data: ArrayBuffer): Uint8Array {
  const idBytes = new TextEncoder().encode(id)
  const out = new Uint8Array(4 + idBytes.length + data.byteLength)
  new DataView(out.buffer).setUint32(0, idBytes.length, false)
  out.set(idBytes, 4)
  out.set(new Uint8Array(data), 4 + idBytes.length)
  return out
}

function decodeFileChunk(raw: ArrayBuffer): { id: string; data: ArrayBuffer } {
  const view = new DataView(raw)
  const idLen = view.getUint32(0, false)
  const id = new TextDecoder().decode(new Uint8Array(raw, 4, idLen))
  return { id, data: raw.slice(4 + idLen) }
}

export function ChatScreen({ myName, roomId, dark, onLeave, onToggleTheme }: Props) {
  const [messages,      setMessages]      = useState<LocalMsg[]>([])
  const [input,         setInput]         = useState('')
  const [peerDisplay,   setPeerDisplay]   = useState<string[]>([])
  const [readyFiles,    setReadyFiles]    = useState<Record<string, string>>({})
  const [acceptedFiles, setAcceptedFiles] = useState<Set<string>>(new Set())
  const [showQR,        setShowQR]        = useState(false)
  const [connState,     setConnState]     = useState<'connecting' | 'ready' | 'blocked'>('connecting')

  const peerNamesRef        = useRef<Map<string, string>>(new Map())
  const msgActionRef        = useRef<Action<TextPayload> | null>(null)
  const fileActionRef       = useRef<Action<FilePayload> | null>(null)
  const fileDataActionRef   = useRef<Action<ArrayBuffer> | null>(null)
  const fileAcceptActionRef = useRef<Action<FileAcceptPayload> | null>(null)
  // Sender buffers file data until a receiver accepts
  const localFilesRef       = useRef<Map<string, ArrayBuffer>>(new Map())
  // Receiver stores MIME from file metadata to use when binary arrives
  const pendingMimeRef      = useRef<Map<string, string>>(new Map())
  // Receiver stores sender peerId to target the accept signal
  const pendingSourceRef    = useRef<Map<string, string>>(new Map())
  const fileInputRef        = useRef<HTMLInputElement>(null)
  const blobUrlsRef         = useRef<string[]>([])
  const bottomRef           = useRef<HTMLDivElement>(null)
  const roomRef = useRef<ReturnType<typeof joinRoom> | null>(null)
  const retryTimerRef = useRef<number | null>(null)

  const { green, muted, border, textC } = themeTokens(dark)
  const onlineCount = peerDisplay.length + 1

  // Tracker 连通探测
  useEffect(() => {
    const trackers = [
      'wss://tracker.openwebtorrent.com',
      'wss://tracker.btorrent.xyz',
      'wss://tracker.fastcast.nz',
    ]
    let failed = 0
    let mounted = true
    const timers: ReturnType<typeof setTimeout>[] = []
    const sockets: WebSocket[] = []

    trackers.forEach(url => {
      const ws = new WebSocket(url)
      sockets.push(ws)
      const tick = setTimeout(() => {
        if (!mounted) return
        failed++
        if (failed >= trackers.length) setConnState('blocked')
      },4000)
      timers.push(tick)
      ws.onopen = () => {
        clearTimeout(tick)
        ws.close()
        if (mounted) setConnState(s => s === 'connecting' ? 'ready' : s)
      }
      ws.onerror = () => {
        clearTimeout(tick)
        if (!mounted) return
        failed++
        if (failed >= trackers.length) setConnState('blocked')
      }
    })

    return () => {
      mounted = false
      timers.forEach(clearTimeout)
      sockets.forEach(ws => { try { ws.close() } catch { /* ignore */ } })
    }
  }, [])

  //房间连接 + 超时自动重连
  useEffect(() => {
    let mounted = true
    function createRoom(){
      roomRef.current?.leave()
      peerNamesRef.current.clear()
      localFilesRef.current.clear()
      pendingMimeRef.current.clear()
      pendingSourceRef.current.clear()

      const room = joinRoom({
        appId: 'whisper-room',
        relayConfig: {
          urls: [
            'wss://tracker.openwebtorrent.com',
            'wss://tracker.btorrent.xyz',
            'wss://tracker.fastcast.nz',
          ],
        },
        trickleIce: true,
        rtcConfig: {
          iceServers: [
            { urls: [
              'stun:stun.l.google.com:19302',
              'stun:stun1.l.google.com:19302',
            ]},
          ],
          iceCandidatePoolSize:10
        },
      }, roomId)

      roomRef.current = room

      const hello      = room.makeAction('hello')      as unknown as Action<HelloPayload>
      const msg        = room.makeAction('msg')        as unknown as Action<TextPayload>
      const file       = room.makeAction('file')       as unknown as Action<FilePayload>
      const fileData   = room.makeAction('fileData')   as unknown as Action<ArrayBuffer>
      const fileAccept = room.makeAction('fileAccept') as unknown as Action<FileAcceptPayload>

      msgActionRef.current        = msg
      fileActionRef.current       = file
      fileDataActionRef.current   = fileData
      fileAcceptActionRef.current = fileAccept

      setMessages([{ id: 'sys-self', from: '', text: `joined #${roomId}`, ts: Date.now(), isSystem: true }])

      room.onPeerJoin = peerId => hello.send({ displayName: myName }, { target: peerId })

      room.onPeerLeave = peerId => {
        const name = peerNamesRef.current.get(peerId) ?? peerId.slice(0, 8)
        peerNamesRef.current.delete(peerId)
        setPeerDisplay(Array.from(peerNamesRef.current.values()))
        setMessages(ms => [...ms, {
          id: `leave-${peerId}-${Date.now()}`, from: '', text: `${name} left`, ts: Date.now(), isSystem: true,
        }])
      }

      hello.onMessage = ({ displayName }, { peerId }) => {
        const isNew = !peerNamesRef.current.has(peerId)
        peerNamesRef.current.set(peerId, displayName)
        setPeerDisplay(Array.from(peerNamesRef.current.values()))
        if (isNew) {
          setMessages(ms => [...ms, {
            id: `join-${peerId}-${Date.now()}`, from: '', text: `${displayName} joined`, ts: Date.now(), isSystem: true,
          }])
          hello.send({ displayName: myName }, { target: peerId })
        }
      }

      msg.onMessage = ({ text, displayName }) => {
        setMessages(ms => [...ms, {
          id: `msg-${Date.now()}-${Math.random()}`, from: displayName, text, ts: Date.now(),
        }])
      }

      file.onMessage = ({ file: f, displayName }, { peerId }) => {
        pendingMimeRef.current.set(f.id, f.mimeType ?? 'application/octet-stream')
        pendingSourceRef.current.set(f.id, peerId)
        setMessages(ms => [...ms, {
          id: `file-${Date.now()}-${Math.random()}`, from: displayName, text: '', ts: Date.now(), file: f,
        }])
      }

      fileData.onMessage = (raw: ArrayBuffer) => {
        const { id, data } = decodeFileChunk(raw)
        const mime = pendingMimeRef.current.get(id) ?? 'application/octet-stream'
        const blob = new Blob([data], { type: mime })
        const url  = URL.createObjectURL(blob)
        blobUrlsRef.current.push(url)
        setReadyFiles(prev => ({ ...prev, [id]: url }))
      }

      fileAccept.onMessage = ({ id }, { peerId }) => {
        const data = localFilesRef.current.get(id)
        if (!data) return
        const chunk = encodeFileChunk(id, data)
        fileDataActionRef.current?.send(chunk as unknown as ArrayBuffer, { target: peerId })
      }
      //12s没搜到任何人自动重连房间
      retryTimerRef.current = window.setTimeout(()=>{
        if(mounted && peerNamesRef.current.size === 0){
          createRoom()
        }
      },12000)
    }

    const startTimer = setTimeout(createRoom,200)

    return () => {
      mounted = false
      clearTimeout(startTimer)
      if(retryTimerRef.current) clearTimeout(retryTimerRef.current)
      msgActionRef.current        = null
      fileActionRef.current       = null
      fileDataActionRef.current   = null
      fileAcceptActionRef.current = null
      blobUrlsRef.current.forEach(url => URL.revokeObjectURL(url))
      blobUrlsRef.current = []
      roomRef.current?.leave()
    }
  }, [roomId, myName])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function send() {
    const text = input.trim()
    if (!text) return
    msgActionRef.current?.send({ text, displayName: myName })
    setMessages(ms => [...ms, { id: `local-${Date.now()}`, from: myName, text, ts: Date.now() }])
    setInput('')
  }

  async function sendFile(f: File) {
    const id       = `f${Date.now()}`
    const mimeType = f.type || 'application/octet-stream'
    const fileInfo = { id, name: f.name, size: f.size, mimeType }
    const data     = await f.arrayBuffer()

    localFilesRef.current.set(id, data)
    await fileActionRef.current?.send({ displayName: myName, file: fileInfo })

    const blob = new Blob([data], { type: mimeType })
    const url  = URL.createObjectURL(blob)
    blobUrlsRef.current.push(url)
    setReadyFiles(prev => ({ ...prev, [id]: url }))
    setMessages(ms => [...ms, { id: `local-file-${Date.now()}`, from: myName, text: '', ts: Date.now(), file: fileInfo }])
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'monospace' }}>

      {/* header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px',
        paddingTop: 'max(10px, env(safe-area-inset-top))',
        borderBottom: `1px solid ${border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: green, letterSpacing: '-0.01em' }}>
            #{roomId}
          </span>
          {connState === 'connecting' ? (
            <span style={{ fontSize: 11, color: muted, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span className="ws-pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: muted, display: 'inline-block' }} />
              connecting…
            </span>
          ) : connState === 'blocked' ? (
            <span style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 5, color: dark ? '#ff7a72' : '#c74f43' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', display: 'inline-block' }} />
              blocked
            </span>
          ) : (
            <span style={{ fontSize: 11, color: muted, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: green, display: 'inline-block', boxShadow: `0 0 6px ${green}` }} />
              {onlineCount} online
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setShowQR(true)} title="Share room QR" style={{
            padding: '4px 8px', cursor: 'pointer', background: 'transparent',
            border: `1px solid ${border}`, borderRadius: 2, color: muted,
            fontFamily: 'monospace', fontSize: 13, lineHeight: 1,
          }}>⊞</button>
          <button onClick={onToggleTheme} title="Toggle theme" style={{
            padding: '4px 8px', cursor: 'pointer', background: 'transparent',
            border: `1px solid ${border}`, borderRadius: 2, color: muted,
            fontFamily: 'monospace', fontSize: 13, lineHeight: 1,
          }}>{dark ? '☀' : '☾'}</button>
          <button onClick={onLeave} style={{
            padding: '4px 10px', cursor: 'pointer', background: 'transparent',
            border: `1px solid ${border}`, borderRadius: 2, color: muted,
            fontFamily: 'monospace', fontSize: 11, letterSpacing: '0.06em',
          }}>leave</button>
        </div>
      </div>

      {/* peers strip */}
      <div style={{
        display: 'flex', padding: '6px 16px',
        borderBottom: `1px solid ${border}`,
        overflowX: 'auto', alignItems: 'center',
        fontSize: 11, color: muted, flexShrink: 0,
      }}>
        {[myName, ...peerDisplay].map((name, i) => (
          <span key={i === 0 ? selfId : name} style={{ flexShrink: 0 }}>
            <span style={{ color: peerColor(name, dark), fontWeight: 600 }}>{name}</span>
            {i === 0 && <span style={{ color: muted, fontSize: 10 }}> (you)</span>}
            {i < peerDisplay.length && <span style={{ margin: '0 8px', opacity: 0.4 }}>·</span>}
          </span>
        ))}
      </div>

      {/* firewall/tracker warning */}
      {connState === 'blocked' && (
        <div style={{
          padding: '7px 16px', flexShrink: 0,
          background: dark ? 'rgba(255,122,114,0.1)' : 'rgba(199,79,67,0.08)',
          borderBottom: `1px solid ${dark ? 'rgba(255,122,114,0.2)' : 'rgba(199,79,67,0.15)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8,
        }}>
          <span style={{ fontSize: 11, fontFamily: 'monospace', color: dark ? '#ff7a72' : '#c74f43', lineHeight: 1.5 }}>
            ⚠ tracker blocked — this network may prevent peers from connecting.
            try a VPN or mobile hotspot.
          </span>
          <button
            onClick={() => setConnState('ready')}
            style={{ background: 'none', border: 'none', cursor: 'pointer',
              color: dark ? '#ff7a72' : '#c74f43', fontSize: 14, lineHeight: 1, flexShrink: 0 }}
          >✕</button>
        </div>
      )}

      {/* messages / loading states */}
      {connState === 'connecting' ? (
        /* Phase 1 — tracker not yet reachable */
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 14, padding: '24px 20px',
        }}>
          <div style={{ display: 'flex', gap: 7, marginBottom: 2 }}>
            {[0, 1, 2].map(i => (
              <span key={i} className="ws-pulse" style={{
                width: 8, height: 8, borderRadius: '50%',
                background: green, display: 'inline-block',
                animationDelay: `${i * 0.22}s`,
              }} />
            ))}
          </div>
          <span style={{ fontSize: 13, color: muted, fontFamily: 'monospace', letterSpacing: '0.04em' }}>
            connecting to #{roomId}…
          </span>
          <span style={{ fontSize: 11, color: muted, opacity: 0.5, fontFamily: 'monospace', textAlign: 'center', lineHeight: 1.7 }}>
            establishing peer network<br />takes a few seconds
          </span>
        </div>
      ) : peerDisplay.length === 0 && messages.length <= 1 ? (
        /* Phase 2 — tracker ok, waiting for first peer */
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 14, padding: '24px 20px',
        }}>
          <div style={{ display: 'flex', gap: 7, marginBottom: 2 }}>
            {[0, 1, 2].map(i => (
              <span key={i} className="ws-pulse" style={{
                width: 7, height: 7, borderRadius: '50%',
                background: muted, display: 'inline-block',
                animationDelay: `${i * 0.22}s`,
              }} />
            ))}
          </div>
          <span style={{ fontSize: 13, color: muted, fontFamily: 'monospace', letterSpacing: '0.04em' }}>
            waiting for peers…
          </span>
          <span style={{ fontSize: 11, color: muted, opacity: 0.5, fontFamily: 'monospace', textAlign: 'center', lineHeight: 1.7 }}>
            share #{roomId}<br />or tap ⊞ for QR code
          </span>
        </div>
      ) : (
        /* Phase 3 — normal chat */
        <div className="bc-scrollbar" style={{
          flex: 1, overflowY: 'auto', padding: '12px 16px',
          display: 'flex', flexDirection: 'column',
        }}>
          {messages.map(m => (
            <MessageRow
              key={m.id} msg={m} myName={myName} dark={dark}
              blobUrl={m.file ? readyFiles[m.file.id] : undefined}
              isAccepted={m.file ? acceptedFiles.has(m.file.id) : false}
              onAccept={m.file ? () => {
                const peerId = pendingSourceRef.current.get(m.file!.id)
                if (!peerId) return
                setAcceptedFiles(prev => new Set([...prev, m.file!.id]))
                fileAcceptActionRef.current?.send({ id: m.file!.id }, { target: peerId })
              } : undefined}
              onReject={m.file ? () => {
                setMessages(ms => ms.filter(x => x.file?.id !== m.file!.id))
                pendingMimeRef.current.delete(m.file!.id)
                pendingSourceRef.current.delete(m.file!.id)
              } : undefined}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      {/* input bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 16px',
        paddingBottom: 'max(10px, env(safe-area-inset-bottom))',
        borderTop: `1px solid ${border}`,
      }}>
        {/* hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="*/*"
          style={{ display: 'none' }}
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) sendFile(f)
            e.target.value = ''
          }}
        />
        <button onClick={() => fileInputRef.current?.click()} title="Send file" style={{
          flexShrink: 0, background: 'transparent', border: 'none',
          color: muted, fontSize: 18, cursor: 'pointer', padding: '4px', lineHeight: 1,
        }}>📎</button>

        <span style={{ color: green, fontSize: 13, flexShrink: 0 }}>▸</span>

        <input
          className="bc-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          placeholder="type a message…"
          style={{
            flex: 1, background: 'transparent', border: 'none',
            color: textC, caretColor: green,
            fontFamily: 'monospace',
            outline: 'none', padding: '4px 0',
          }}
        />

        <button
          onClick={send}
          disabled={!input.trim()}
          style={{
            flexShrink: 0, padding: '5px 14px',
            background: input.trim() ? green : 'transparent',
            color:      input.trim() ? (dark ? '#0a0a0a' : '#fff') : muted,
            border:     `1px solid ${input.trim() ? green : border}`,
            borderRadius: 2, cursor: input.trim() ? 'pointer' : 'default',
            fontFamily: 'monospace', fontSize: 12, fontWeight: 600,
            letterSpacing: '0.06em', transition: 'all 0.12s',
          }}
        >send</button>
      </div>

      {showQR && <QRModal roomId={roomId} dark={dark} onClose={() => setShowQR(false)} />}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { OverlayBridge } from '../../shared/bridge'

declare global {
  interface Window {
    overlay: OverlayBridge
  }
}

interface InitData {
  displayId: number
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  /** v0.9.8: 이 창이 화면 캡처에서 제외됨 (macOS) → UI 즉시 표시 가능 */
  uiSafe?: boolean
}

interface Point {
  x: number
  y: number
}

/**
 * v0.8.3 영역 캡처 — 1-step 모델 (v0.8.2의 2-step 되돌림)
 *
 * 드래그 → 릴리즈 = 즉시 캡처. 빠른 워크플로우 우선.
 * 취소: Esc / 우클릭 / 가운데 마우스 버튼.
 */
export function Overlay(): JSX.Element {
  const [init, setInit] = useState<InitData | null>(null)
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null)
  const [start, setStart] = useState<Point | null>(null)
  const [current, setCurrent] = useState<Point | null>(null)
  const [mouse, setMouse] = useState<Point | null>(null)
  const draggingRef = useRef(false)
  // v0.9.4: 배경 준비 여부를 ref 로도 추적 (드래그 시작 시점 판단용)
  const bgReadyRef = useRef(false)
  const dragStartedWithBgRef = useRef(false)
  // v0.9.8: 캡처 제외 창 여부 (macOS) — true 면 UI 즉시 표시 + 스냅샷 항상 안전
  const uiSafeRef = useRef(false)

  useEffect(() => {
    window.overlay.onInit((data) => {
      setInit(data)
      uiSafeRef.current = !!data.uiSafe
      setBackgroundUrl(null)
      bgReadyRef.current = false
      dragStartedWithBgRef.current = false
      setStart(null)
      setCurrent(null)
      setMouse(null)
      draggingRef.current = false
    })

    // v0.9.4: 스냅샷 배경은 오버레이 표시 후 늦게 도착 (~100-300ms).
    // 도착 전까지는 완전 투명이라 라이브 화면이 그대로 보임 → 스냅샷에 UI 안 찍힘.
    window.overlay.onBackground((data) => {
      // 배경 도착 전에 이미 드래그를 시작했다면 그 스냅샷엔 드래그 UI(dim/테두리)가
      // 찍혀있을 수 있으므로 적용하지 않음 → submit 시 snapshotOk=false 로 라이브 캡처
      // v0.9.8: uiSafe(캡처 제외 창)면 UI 가 스냅샷에 안 찍히므로 항상 안전하게 적용
      if (draggingRef.current && !dragStartedWithBgRef.current && !uiSafeRef.current) return
      setBackgroundUrl(data.backgroundUrl)
      bgReadyRef.current = true
    })

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.overlay.cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onMouseDown = (e: React.MouseEvent): void => {
    draggingRef.current = true
    // uiSafe 창은 캡처에서 제외되므로 배경 도착 전 드래그여도 스냅샷이 오염되지 않음
    dragStartedWithBgRef.current = bgReadyRef.current || uiSafeRef.current
    setStart({ x: e.clientX, y: e.clientY })
    setCurrent({ x: e.clientX, y: e.clientY })
  }

  const onMouseMove = (e: React.MouseEvent): void => {
    setMouse({ x: e.clientX, y: e.clientY })
    if (!draggingRef.current) return
    setCurrent({ x: e.clientX, y: e.clientY })
  }

  const onMouseUp = (): void => {
    if (!draggingRef.current || !start || !current || !init) {
      draggingRef.current = false
      return
    }
    draggingRef.current = false
    const sel = computeRect(start, current)
    if (sel.width < 4 || sel.height < 4) {
      setStart(null)
      setCurrent(null)
      return
    }
    // 1-step: 즉시 submit
    window.overlay.submit({
      displayId: init.displayId,
      x: sel.x,
      y: sel.y,
      width: sel.width,
      height: sel.height,
      snapshotOk: dragStartedWithBgRef.current
    })
  }

  if (!init) {
    return <div style={{ width: '100vw', height: '100vh' }} />
  }

  const rect = start && current ? computeRect(start, current) : null

  return (
    <div
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onContextMenu={(e) => {
        e.preventDefault()
        window.overlay.cancel()
      }}
      onAuxClick={(e) => {
        if (e.button === 1 || e.button === 2) {
          e.preventDefault()
          window.overlay.cancel()
        }
      }}
      style={{
        width: '100vw',
        height: '100vh',
        position: 'relative',
        overflow: 'hidden',
        cursor: 'crosshair',
        background: 'rgba(0,0,0,0.003)'
      }}
    >
      {backgroundUrl && (
        <img
          src={backgroundUrl}
          alt=""
          draggable={false}
          className="pointer-events-none"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'fill',
            userSelect: 'none'
          }}
        />
      )}
      {rect && (
        <div
          className="pointer-events-none"
          style={{
            position: 'absolute',
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
            border: '1.5px solid #3B82F6',
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)'
          }}
        />
      )}

      {rect && (
        <div
          className="pointer-events-none"
          style={{
            position: 'absolute',
            left: rect.x,
            top: rect.y > 28 ? rect.y - 26 : rect.y + rect.height + 6,
            background: 'rgba(0,0,0,0.85)',
            color: 'white',
            padding: '3px 8px',
            borderRadius: 4,
            fontSize: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            whiteSpace: 'nowrap'
          }}
        >
          {rect.width} × {rect.height}
        </div>
      )}

      {/* v0.9.4: 좌표 배지/안내 배너는 스냅샷 배경 도착 후에만 표시
          (도착 전에 표시하면 백그라운드 스냅샷 캡처에 UI가 찍힘)
          v0.9.8: uiSafe 창(macOS, 캡처 제외)은 즉시 표시 → 단축키 반응 즉각 체감 */}
      {(backgroundUrl || init.uiSafe) && !rect && mouse && (
        <div
          className="pointer-events-none"
          style={{
            position: 'absolute',
            left: Math.min(mouse.x + 18, init.bounds.width - 120),
            top: Math.min(mouse.y + 18, init.bounds.height - 30),
            background: 'rgba(0,0,0,0.75)',
            color: 'white',
            padding: '3px 8px',
            borderRadius: 4,
            fontSize: 11,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
          }}
        >
          {mouse.x}, {mouse.y}
        </div>
      )}

      {(backgroundUrl || init.uiSafe) && (
        <div
          className="pointer-events-none"
          style={{
            position: 'absolute',
            top: 14,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.7)',
            color: 'white',
            padding: '6px 14px',
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 500
          }}
        >
          드래그하여 영역 선택 · ESC / 우클릭 취소
        </div>
      )}
    </div>
  )
}

function computeRect(
  a: { x: number; y: number },
  b: { x: number; y: number }
): { x: number; y: number; width: number; height: number } {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  }
}

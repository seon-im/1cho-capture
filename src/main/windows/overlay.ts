import { BrowserWindow, Display, globalShortcut, nativeImage, powerMonitor, screen } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { captureRegion } from '../capture'
import { IPC } from '../../shared/constants'
import type { CaptureResult, RegionSelection } from '../../shared/types'
import { openEditorWithImage } from './editor'
import { hideToolbarForCapture, restoreToolbarAfterCapture } from './toolbar'

/**
 * v0.9.0 스냅샷 방식으로 전환.
 *
 * 단축키 → 오버레이 창 띄우기 *전에* 각 디스플레이 즉시 캡처 → 그 스냅샷을
 * 오버레이 배경으로 표시 → 드래그 완료 시 스냅샷에서 crop.
 *
 * 이렇게 하면 오버레이 활성화(포커스 이동) 로 팝업/드롭다운 메뉴가 닫혀도
 * 이미 찍힌 스냅샷은 팝업이 열려있던 상태 그대로 유지된다.
 */

interface SnapshotEntry {
  filePath: string
  dipWidth: number
  dipHeight: number
}
const snapshots = new Map<number, SnapshotEntry>()
// v0.9.4: 비동기 스냅샷 세션 구분 — ESC 취소 후 뒤늦게 완료된 캡처가
// 다음 세션에 끼어들지 않도록 세대 번호로 가드
let snapshotGeneration = 0

/**
 * v0.3.1 UX 개편: 맥 Cmd+Shift+4 처럼 "라이브 화면" 위에 투명 오버레이만 띄우고,
 * 드래그가 끝나면 오버레이를 숨긴 뒤 해당 영역만 네이티브로 캡처한다.
 *
 * 이전 v0.3.0은 단축키 누를 때 전체 화면을 먼저 스냅샷으로 찍어 그 이미지 위에 드래그를
 * 받았기에, 순간적으로 화면이 정지/배율 살짝 어긋남 등 어색함이 있었다.
 *
 * 창 예열 자체는 유지 — 지연은 여전히 ~50ms 수준.
 */

interface OverlayEntry {
  window: BrowserWindow
  displayId: number
  ready: boolean
}

const entries: OverlayEntry[] = []
let isOpen = false
let autoResetTimer: NodeJS.Timeout | null = null
const AUTO_RESET_MS = 60_000 // 60초 안에 사용자 액션 없으면 강제 정리

function buildOverlayWindow(d: Display): OverlayEntry {
  const w = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    fullscreen: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/overlay.js'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  w.setAlwaysOnTop(true, 'screen-saver')
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // v0.9.8 (macOS): 오버레이 창을 화면 캡처에서 제외 (NSWindowSharingNone).
  // → 스냅샷(screencapture)에 오버레이 UI가 절대 안 찍히므로, 안내 배너/좌표를
  //   스냅샷 도착을 기다리지 않고 즉시 표시 가능 → 단축키 체감 반응 즉각적.
  // Windows 는 캡처 API(DXGI)에 따라 검은 영역이 생길 수 있어 적용 안 함.
  if (process.platform === 'darwin') {
    try {
      w.setContentProtection(true)
    } catch (e) {
      console.warn('[overlay] setContentProtection 실패:', e)
    }
  }

  const entry: OverlayEntry = { window: w, displayId: d.id, ready: false }

  w.webContents.once('did-finish-load', () => {
    entry.ready = true
  })

  // v0.7.7: ESC를 main 단에서 직접 잡음 (renderer keydown 리스너가 포커스 문제로
  // 못 받는 케이스 대비). before-input-event 는 webContents가 살아있는 한 잡힘.
  w.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'Escape') {
      event.preventDefault()
      cancelRegionOverlay()
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    w.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay/index.html`)
  } else {
    w.loadFile(path.join(__dirname, '../renderer/overlay/index.html'))
  }

  return entry
}

export function prewarmOverlayWindows(): void {
  disposeAllOverlays()
  for (const d of screen.getAllDisplays()) {
    entries.push(buildOverlayWindow(d))
  }

  screen.on('display-added', (_, d) => {
    console.log('[overlay] display-added → 오버레이 추가')
    entries.push(buildOverlayWindow(d))
  })
  screen.on('display-removed', (_, d) => {
    console.log('[overlay] display-removed → 오버레이 제거')
    const idx = entries.findIndex((e) => e.displayId === d.id)
    if (idx >= 0) {
      const [removed] = entries.splice(idx, 1)
      if (!removed.window.isDestroyed()) removed.window.destroy()
    }
  })

  // v0.7.5: DPI/해상도/회전 등 디스플레이 메트릭 변경 시 오버레이 재구축
  // 그렇지 않으면 미리 만든 창의 좌표/크기가 어긋나 첫 캡처가 실패함.
  screen.on('display-metrics-changed', () => {
    console.log('[overlay] display-metrics-changed → 오버레이 재구축')
    rebuildAllOverlays()
  })

  // v0.7.5: 시스템 절전(suspend/sleep)에서 깨어나면 오버레이가 stale 상태가
  // 되어 첫 단축키가 무반응인 케이스가 많아, 깨어남 직후 살짝 지연 두고 재구축.
  powerMonitor.on('resume', () => {
    console.log('[overlay] system resume → 1초 후 오버레이 재구축')
    setTimeout(rebuildAllOverlays, 1000)
  })
  powerMonitor.on('unlock-screen', () => {
    console.log('[overlay] unlock-screen → 오버레이 재구축')
    setTimeout(rebuildAllOverlays, 500)
  })
}

function disposeAllOverlays(): void {
  while (entries.length) {
    const e = entries.pop()
    if (e && !e.window.isDestroyed()) e.window.destroy()
  }
  isOpen = false
  if (autoResetTimer) {
    clearTimeout(autoResetTimer)
    autoResetTimer = null
  }
}

/** v0.7.5: 모든 오버레이 창을 폐기하고 현재 디스플레이 구성으로 새로 만듦. */
function rebuildAllOverlays(): void {
  disposeAllOverlays()
  for (const d of screen.getAllDisplays()) {
    entries.push(buildOverlayWindow(d))
  }
}

/** v0.7.5: 깨진 entry 정리 + 누락된 디스플레이는 새로 빌드. */
function ensureHealthyEntries(): void {
  // 깨진 창 제거
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.window.isDestroyed()) {
      entries.splice(i, 1)
    }
  }
  // 누락된 디스플레이 채움
  const have = new Set(entries.map((e) => e.displayId))
  for (const d of screen.getAllDisplays()) {
    if (!have.has(d.id)) {
      console.log('[overlay] 누락된 디스플레이 발견 → 새 오버레이 생성', d.id)
      entries.push(buildOverlayWindow(d))
    }
  }
}

function isAnyOverlayVisible(): boolean {
  return entries.some((e) => !e.window.isDestroyed() && e.window.isVisible())
}

/**
 * v0.7.10: 오버레이 1개를 안전하게 보여주는 통합 헬퍼.
 *
 * 듀얼 모니터(서로 다른 DPI/배율) 환경에서 미리 만들어둔 BrowserWindow 의
 * x/y/width/height 가 OS 입장에선 stale 일 수 있어, 매 show 직전마다
 * 현재 display.bounds 로 강제 재적용한다. 또한 alwaysOnTop 'screen-saver'
 * 레벨도 매번 재확인해서 작업표시줄 위로 확실히 뜨도록 한다.
 *
 * 적용된 실제 bounds 가 요청과 다르면 경고 로그 (Windows 작업표시줄 등에
 * 의해 클리핑됐을 가능성).
 */
function showOverlayEntry(entry: OverlayEntry, display: Display): void {
  if (entry.window.isDestroyed()) return

  // 1. bounds 강제 재적용
  try {
    entry.window.setBounds(display.bounds, false)
  } catch (e) {
    console.warn('[overlay] setBounds 실패:', e)
  }

  // 2. alwaysOnTop 레벨 재확인 (작업표시줄 위로 확실히 뜨게)
  try {
    entry.window.setAlwaysOnTop(true, 'screen-saver')
    entry.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } catch (e) {
    console.warn('[overlay] setAlwaysOnTop 실패:', e)
  }

  // 3. init payload 전송 (v0.9.4: 배경은 스냅샷 완료 시 OVERLAY_BACKGROUND 로 늦게 전달)
  // v0.9.8: uiSafe = 이 창이 화면 캡처에서 제외됨 (macOS contentProtection)
  //         → renderer 가 배너/좌표 UI 를 즉시 표시해도 스냅샷에 안 찍힘
  entry.window.webContents.send(IPC.OVERLAY_INIT, {
    displayId: entry.displayId,
    bounds: display.bounds,
    scaleFactor: display.scaleFactor,
    uiSafe: process.platform === 'darwin'
  })

  // 4. show — v0.8.5: focus() 제거. 오버레이가 포커스를 가져가면 다른 앱의
  // 펼쳐진 메뉴/드롭다운/시작메뉴 등이 자동으로 닫혀버려서 그 상태를 캡처
  // 못 하던 문제. showInactive 만 호출해서 등장 시점엔 포커스 변경 없음.
  // 키보드 입력(ESC)은 v0.7.7 의 globalShortcut.register('Escape')으로 처리.
  entry.window.showInactive()

  // 5. 적용된 bounds 검증 — Windows 작업표시줄 등에 의해 클리핑됐는지 체크
  try {
    const actual = entry.window.getBounds()
    if (
      actual.x !== display.bounds.x ||
      actual.y !== display.bounds.y ||
      actual.width !== display.bounds.width ||
      actual.height !== display.bounds.height
    ) {
      console.warn(
        '[overlay] bounds 불일치 — 요청:',
        display.bounds,
        '실제:',
        actual,
        '→ 강제 재적용 시도'
      )
      // 한 번 더 시도 — show 후엔 setBounds가 더 잘 먹는 경우가 있음
      try {
        entry.window.setBounds(display.bounds, false)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

async function waitForReady(entry: OverlayEntry, timeoutMs = 2000): Promise<void> {
  if (entry.ready) return
  return new Promise((resolve) => {
    const start = Date.now()
    const check = (): void => {
      if (entry.ready) return resolve()
      if (Date.now() - start > timeoutMs) return resolve()
      setTimeout(check, 10)
    }
    check()
  })
}

/**
 * v0.9.6: 상시 대기 점검용 — 캡처 세션이 없을 때 깨진/누락 오버레이 창을 재정비.
 * 오래 방치 후 첫 캡처가 느리거나 무반응인 문제 예방 (30분 주기 호출).
 */
export function keepOverlaysWarm(): void {
  if (isOpen) return
  try {
    ensureHealthyEntries()
  } catch (e) {
    console.warn('[overlay] keepOverlaysWarm 실패:', e)
  }
}

/** 단축키 진입점: 라이브 화면 위에 투명 오버레이 즉시 표시. */
export async function openRegionOverlay(): Promise<void> {
  // v0.7.5: 깨진 entries 정리 + 디스플레이 변경 자동 반영
  ensureHealthyEntries()

  // 이미 보이는 오버레이가 있으면 진짜 열린 상태 → 무시
  if (isAnyOverlayVisible()) {
    isOpen = true
    return
  }

  // isOpen 플래그가 stuck 상태면 자동 리셋 (첫 단축키 무반응 → 두 번째에 작동 패턴 해결)
  if (isOpen) {
    console.warn('[overlay] isOpen이 true인데 보이는 창이 없음 → 자동 리셋')
    isOpen = false
  }

  isOpen = true
  hideToolbarForCapture()

  // v0.9.4: 오버레이를 먼저 즉시 표시하고 (투명 + 포커스 안 뺏음 → 팝업 유지,
  // 캡처에 안 찍힘), 스냅샷은 백그라운드에서 찍어 완료되는 대로 배경으로 전달.
  // 체감 반응속도가 스냅샷 캡처 시간(~150-300ms)만큼 빨라짐.
  capturePerDisplaySnapshots().catch((e) =>
    console.warn('[overlay] 백그라운드 스냅샷 실패:', e)
  )

  try {
    let shownCount = 0
    for (const entry of entries) {
      await waitForReady(entry)
      if (entry.window.isDestroyed()) continue
      const display = screen.getAllDisplays().find((d) => d.id === entry.displayId)
      if (!display) continue
      try {
        showOverlayEntry(entry, display)
        shownCount++
      } catch (showErr) {
        console.warn('[overlay] show 실패, 해당 entry 폐기', showErr)
        if (!entry.window.isDestroyed()) entry.window.destroy()
      }
    }

    // 단 하나도 못 띄웠으면 → 전체 재구축 후 한 번 재시도
    if (shownCount === 0) {
      console.warn('[overlay] 0개 표시됨 → 전체 재구축 후 재시도')
      isOpen = false
      rebuildAllOverlays()
      // 재시도는 한 번만
      for (const entry of entries) {
        await waitForReady(entry, 2000)
        if (entry.window.isDestroyed()) continue
        const display = screen.getAllDisplays().find((d) => d.id === entry.displayId)
        if (!display) continue
        showOverlayEntry(entry, display)
        shownCount++
      }
      if (shownCount === 0) {
        throw new Error('재구축 후에도 오버레이를 표시할 수 없음')
      }
      isOpen = true
    }

    // v0.7.7: 어떤 앱이 포커스든 ESC를 잡기 위해 글로벌 단축키 임시 등록.
    // 오버레이 닫힐 때 unregister.
    try {
      globalShortcut.register('Escape', () => {
        console.log('[overlay] global Escape → cancel')
        cancelRegionOverlay()
      })
    } catch (e) {
      console.warn('[overlay] globalShortcut Escape 등록 실패:', e)
    }

    // 60초 안에 사용자 액션 없으면 자동 정리 (stuck 방지)
    if (autoResetTimer) clearTimeout(autoResetTimer)
    autoResetTimer = setTimeout(() => {
      console.warn('[overlay] 60초 무액션 → 자동 정리')
      cancelRegionOverlay()
    }, AUTO_RESET_MS)
  } catch (e) {
    console.error('[overlay] openRegionOverlay', e)
    isOpen = false
    closeAllOverlays()
    restoreToolbarAfterCapture()
  }
}

export function closeAllOverlays(): void {
  for (const e of entries) {
    if (!e.window.isDestroyed() && e.window.isVisible()) {
      e.window.hide()
    }
  }
  isOpen = false
  // v0.7.5: 자동 reset 타이머 정리
  if (autoResetTimer) {
    clearTimeout(autoResetTimer)
    autoResetTimer = null
  }
  // v0.7.7: 임시 등록한 글로벌 ESC 해제 (다른 앱이 ESC 다시 사용할 수 있도록)
  try {
    if (globalShortcut.isRegistered('Escape')) {
      globalShortcut.unregister('Escape')
    }
  } catch {
    /* ignore */
  }
}

/** 사용자가 ESC 등으로 선택을 취소한 경우: 툴바 복원 + 스냅샷 정리 */
export function cancelRegionOverlay(): void {
  closeAllOverlays()
  disposeSnapshots().catch(() => undefined)
  restoreToolbarAfterCapture()
}

/**
 * v0.9.1: 스냅샷 캡처 고속화.
 *
 * v0.9.0 은 디스플레이마다 순차 캡처 + 즉시 PNG 디코드였는데 (2대 기준 ~500ms+),
 * - Mac: 디스플레이별 screencapture 를 병렬 실행 (프로세스 독립이라 안전)
 * - Win: PS 세션이 명령을 직렬 처리하므로, 가상 전체화면을 *1회* 캡처한 뒤
 *        main 에서 디스플레이별로 crop (PS 왕복 1번, PNG 인코딩 1번)
 * - PNG 디코드(nativeImage)는 드래그 완료 시점으로 지연 — 오버레이 표시엔
 *   file:// 경로만 있으면 됨
 */
async function capturePerDisplaySnapshots(): Promise<void> {
  await disposeSnapshots()
  const gen = ++snapshotGeneration
  const displays = screen.getAllDisplays()
  const t0 = Date.now()

  // v0.9.2: Mac/Win 동일하게 디스플레이별 병렬 캡처.
  // Mac 은 screencapture (v0.9.4: 최종 경로에 직접 저장, 이중 I/O 제거),
  // Win 은 desktopCapturer (Electron 이 모니터별 DPI 직접 처리).
  // v0.9.4: 각 디스플레이 캡처가 끝나는 즉시 해당 오버레이에 배경 URL 전달.
  await Promise.all(
    displays.map(async (d) => {
      try {
        let filePath: string
        if (process.platform === 'darwin') {
          const outPath = path.join(
            os.tmpdir(),
            `1cho_cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`
          )
          const { captureRegionMacToFile } = await import('../capture/mac')
          await captureRegionMacToFile(
            d.bounds.x,
            d.bounds.y,
            d.bounds.width,
            d.bounds.height,
            outPath
          )
          filePath = outPath
        } else {
          const phys = screen.dipToScreenRect(null, d.bounds)
          const res = await captureRegion(phys.x, phys.y, phys.width, phys.height)
          if (!res.filePath) return
          filePath = res.filePath
        }

        // 세션이 바뀌었으면 (ESC 취소 후 등) 결과 폐기
        if (gen !== snapshotGeneration) {
          fs.unlink(filePath).catch(() => undefined)
          return
        }

        snapshots.set(d.id, {
          filePath,
          dipWidth: d.bounds.width,
          dipHeight: d.bounds.height
        })

        // 해당 디스플레이 오버레이에 배경 즉시 전달
        const entry = entries.find((e) => e.displayId === d.id)
        if (entry && !entry.window.isDestroyed() && entry.window.isVisible()) {
          entry.window.webContents.send(IPC.OVERLAY_BACKGROUND, {
            backgroundUrl: pathToFileURL(filePath).href
          })
        }
      } catch (e) {
        console.warn('[overlay] display snapshot 실패 displayId=' + d.id, e)
      }
    })
  )

  console.log(`[overlay] snapshots captured in ${Date.now() - t0}ms (${snapshots.size} displays)`)
}

async function disposeSnapshots(): Promise<void> {
  snapshotGeneration++ // 진행 중인 비동기 캡처 결과 무효화
  const toRemove = Array.from(snapshots.values())
  snapshots.clear()
  await Promise.all(
    toRemove.map((s) => fs.unlink(s.filePath).catch(() => undefined))
  )
}

/**
 * v0.9.0: 드래그 완료 → 저장된 스냅샷에서 해당 영역 crop.
 * 실제 화면을 다시 캡처하지 않으므로, 오버레이가 뜨는 사이 팝업이 닫혔어도
 * 스냅샷은 팝업이 열려있던 상태 그대로 유지됨.
 */
export async function handleOverlaySelection(selection: RegionSelection): Promise<void> {
  closeAllOverlays()

  const display = screen.getAllDisplays().find((d) => d.id === selection.displayId)
  if (!display) {
    await disposeSnapshots()
    restoreToolbarAfterCapture()
    return
  }

  // v0.7.0: 스크롤 캡처 모드면 실시간 화면을 스크롤하며 캡처해야 하므로
  // 스냅샷 방식이 아니라 기존처럼 라이브 좌표계로 넘김.
  try {
    const scrollMod = await import('../capture/scroll')
    if (scrollMod.consumeScrollSelectionFlag()) {
      let absX = display.bounds.x + selection.x
      let absY = display.bounds.y + selection.y
      let capW = selection.width
      let capH = selection.height
      if (process.platform === 'win32') {
        const phys = screen.dipToScreenRect(null, {
          x: absX,
          y: absY,
          width: capW,
          height: capH
        })
        absX = phys.x
        absY = phys.y
        capW = phys.width
        capH = phys.height
      }
      await scrollMod.beginScrollSession(
        { x: absX, y: absY, width: capW, height: capH },
        display.id,
        display.scaleFactor
      )
      await disposeSnapshots()
      restoreToolbarAfterCapture()
      return
    }
  } catch (e) {
    console.warn('[overlay] scroll mode check fail:', e)
  }

  try {
    // v0.9.4: 드래그가 스냅샷 도착 전에 시작됐다면 (snapshotOk=false) 스냅샷에
    // 드래그 UI가 찍혀있을 수 있으므로 라이브 캡처로 처리
    const snap =
      selection.snapshotOk === false ? undefined : snapshots.get(selection.displayId)
    let result: CaptureResult

    if (snap) {
      // 스냅샷에서 crop — 디코드는 이 시점에 (v0.9.1: 캡처 시점 디코드 비용 제거).
      // DIP 좌표(selection.x/y/w/h)를 물리 픽셀 좌표로 변환.
      const image = nativeImage.createFromPath(snap.filePath)
      const { width: physWidth, height: physHeight } = image.getSize()
      const sfx = physWidth / snap.dipWidth
      const sfy = physHeight / snap.dipHeight
      const cropX = Math.max(0, Math.round(selection.x * sfx))
      const cropY = Math.max(0, Math.round(selection.y * sfy))
      const cropW = Math.max(1, Math.min(physWidth - cropX, Math.round(selection.width * sfx)))
      const cropH = Math.max(1, Math.min(physHeight - cropY, Math.round(selection.height * sfy)))
      const cropped = image.crop({ x: cropX, y: cropY, width: cropW, height: cropH })
      const buf = cropped.toPNG()
      const outPath = path.join(
        os.tmpdir(),
        `1cho_cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`
      )
      await fs.writeFile(outPath, buf)
      result = { filePath: outPath, width: cropW, height: cropH }
      console.log('[overlay] cropped from snapshot →', outPath, cropW, 'x', cropH)
    } else {
      // fallback: 스냅샷이 없으면 라이브 캡처 (v0.8.x 방식)
      console.warn('[overlay] no snapshot for display', selection.displayId, '→ live capture fallback')
      await new Promise((r) => setTimeout(r, process.platform === 'win32' ? 100 : 60))
      let absX = display.bounds.x + selection.x
      let absY = display.bounds.y + selection.y
      let capW = selection.width
      let capH = selection.height
      if (process.platform === 'win32') {
        const phys = screen.dipToScreenRect(null, {
          x: absX,
          y: absY,
          width: capW,
          height: capH
        })
        absX = phys.x
        absY = phys.y
        capW = phys.width
        capH = phys.height
      }
      result = await captureRegion(absX, absY, capW, capH)
    }

    await openEditorWithImage(result)
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    console.error('[overlay] selection 처리 실패:', msg)
    try {
      const { Notification } = await import('electron')
      new Notification({
        title: '1초캡처 — 캡처 실패',
        body:
          process.platform === 'darwin'
            ? '화면 녹화 권한이 허용됐는지 확인해주세요.\n시스템 설정 → 개인정보 보호 및 보안 → 화면 녹화.'
            : '캡처에 실패했습니다. ' + msg
      }).show()
    } catch {
      /* ignore */
    }
  } finally {
    await disposeSnapshots()
    restoreToolbarAfterCapture()
  }
}

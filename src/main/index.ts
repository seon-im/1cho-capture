import { app, BrowserWindow, powerMonitor } from 'electron'
import fsSync from 'node:fs'
import { createTray, rebuildMenu, setHotkeyFailureBadge } from './tray'
import { registerHotkeys, unregisterAllHotkeys } from './hotkey'
import { registerIpcHandlers } from './ipc'
import { getSettings } from './store'
import { prewarmOverlayWindows, keepOverlaysWarm } from './windows/overlay'
import { prewarmEditorWindow, destroyEditorWindow } from './windows/editor'
import {
  createToolbarWindow,
  destroyToolbarWindow,
  showToolbar
} from './windows/toolbar'
import { setupAutoUpdater } from './updater'
import { cleanupTempCaptures } from './capture'
import { prewarmPowerShell, destroyPowerShell } from './capture/win'
import { applyAutoStart } from './autostart'
import { promises as fs } from 'node:fs'
import path from 'node:path'

// Single instance
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

// v0.9.6: 일부 PC(구형 GPU 드라이버, 원격데스크톱 등)에서 투명 오버레이 창이
// 검게 렌더링되는 문제 자동 복구. GPU 프로세스가 반복 크래시하면 플래그를
// 남기고, 다음 실행부터 하드웨어 가속을 꺼서 소프트웨어 합성으로 동작
// (투명 창이 정상 표시됨).
const hwAccelFlagPath = path.join(app.getPath('userData'), 'disable-hw-accel')
try {
  if (fsSync.existsSync(hwAccelFlagPath)) {
    app.disableHardwareAcceleration()
    console.log('[main] GPU 문제 이력 감지 → 하드웨어 가속 비활성화 모드로 실행')
  }
} catch {
  /* ignore */
}
let gpuCrashCount = 0
app.on('child-process-gone', (_e, details) => {
  if (details.type === 'GPU' && details.reason !== 'clean-exit') {
    gpuCrashCount++
    console.warn('[main] GPU 프로세스 종료 감지:', details.reason, `(${gpuCrashCount}회)`)
    if (gpuCrashCount >= 2) {
      try {
        fsSync.writeFileSync(hwAccelFlagPath, new Date().toISOString())
        console.warn('[main] 다음 실행부터 하드웨어 가속 끔 (검은 화면 문제 자동 복구)')
      } catch {
        /* ignore */
      }
    }
  }
})

// 이미 앱이 실행 중인 상태에서 데스크톱 아이콘이 또 클릭되면 → 툴바 팝업
app.on('second-instance', () => {
  showToolbar()
  rebuildMenu()
})

// Hide dock icon on Mac; tray-only app
if (process.platform === 'darwin') {
  app.dock?.hide()
}

app.whenReady().then(async () => {
  // Ensure save folder exists
  try {
    await fs.mkdir(getSettings().saveFolder, { recursive: true })
  } catch {
    // ignore
  }

  // v0.6.0: 이전 실행에서 남은 임시 캡처 파일 정리
  cleanupTempCaptures()

  // v0.6.0: Windows에서 PowerShell 세션 프리워밍
  if (process.platform === 'win32') {
    prewarmPowerShell()

    // v0.7.5: 시스템 절전에서 깨어나면 PS 세션이 죽어있을 수 있어 재시작.
    // 이걸 안 하면 깨어난 직후 첫 캡처가 무반응 → 두 번째에 새 PS 띄워서 작동
    // 하는 패턴이 발생함.
    powerMonitor.on('resume', () => {
      console.log('[main] system resume → PowerShell 세션 재시작')
      destroyPowerShell()
      setTimeout(prewarmPowerShell, 500)
    })
  }

  registerIpcHandlers()
  createTray()

  // 단축키 등록 결과를 받아서 실패 시 트레이에 배지 표시 (v0.3.0)
  const { failed } = registerHotkeys(getSettings().hotkeys)
  setHotkeyFailureBadge(failed)

  // v0.3.0: 창 예열 — 앱 시작 시 숨김 상태로 미리 생성해서 첫 캡처 지연 제거.
  prewarmOverlayWindows()
  prewarmEditorWindow()

  // v0.4.0/0.6.3: 플로팅 툴바.
  // - 사용자가 직접 실행하면 툴바를 띄움 (처음 UI 탐색에 도움)
  // - OS 로그인 시 자동 실행된 경우엔 트레이에만 조용히 상주 (창 X)
  //   → setLoginItemSettings에서 설정한 '--autostart' 플래그(Win) 또는
  //     wasOpenedAtLogin 플래그(macOS) 로 판별
  const wasAutoStarted =
    process.argv.includes('--autostart') ||
    (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin)

  const showToolbarOnStartup = getSettings().toolbar?.showOnStartup ?? true
  const shouldShowToolbar = showToolbarOnStartup && !wasAutoStarted
  createToolbarWindow(shouldShowToolbar)
  // 툴바 보이기/숨기기 상태 반영
  setTimeout(rebuildMenu, 100)

  // v0.5.0: 자동 업데이트 (백그라운드 다운로드 + 다음 종료 시 적용)
  setupAutoUpdater()

  // v0.9.6: 상시 대기 모드 — 30분마다 예열 상태 점검.
  // 오래 방치하면 OS가 프로세스/창을 정리해 첫 캡처가 느려지는 문제 예방:
  // 깨진 오버레이 창 재생성, 편집기 창 재예열, (Win) PowerShell 세션 유지.
  setInterval(() => {
    try {
      keepOverlaysWarm()
      prewarmEditorWindow()
      if (process.platform === 'win32') prewarmPowerShell()
    } catch (e) {
      console.warn('[main] standby 점검 실패:', e)
    }
  }, 30 * 60 * 1000)

  // v0.6.2: 사용자 설정에 따라 OS 로그인 자동 시작 반영
  applyAutoStart(getSettings().autoStart)

  app.on('activate', () => {
    // macOS 도크 숨겨져 있지만 혹시 재활성화되면 툴바 보이기
    showToolbar()
    if (BrowserWindow.getAllWindows().length === 0) {
      // no-op
    }
  })
})

app.on('window-all-closed', () => {
  // Keep app running in background (tray-only)
})

app.on('before-quit', async () => {
  // close preventDefault 걸려있는 창들 종료 전에 명시 해제
  destroyEditorWindow()
  destroyToolbarWindow()
  // v0.8.9: 지연 배지 정리
  try {
    const dm = await import('./windows/delayBadge')
    dm.destroyDelayBadge()
  } catch {
    /* ignore */
  }
  // v0.6.0: PowerShell 세션 정리
  if (process.platform === 'win32') destroyPowerShell()
})

app.on('will-quit', () => {
  unregisterAllHotkeys()
})

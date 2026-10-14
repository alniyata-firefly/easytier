import { invoke } from '@tauri-apps/api/core'
import { type as osType } from '@tauri-apps/plugin-os'
import { appConfigDir, appLogDir, join } from '@tauri-apps/api/path'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { open } from '@tauri-apps/plugin-shell'
import { exit } from '@tauri-apps/plugin-process'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { TrayIcon } from '@tauri-apps/api/tray'
import type { ServiceMode } from './types'

export async function getServiceDefaults(): Promise<ServiceMode> {
  return { mode: 'service', config_dir: await join(await appConfigDir(), 'config.d'), file_log_dir: await appLogDir(), file_log_level: 'off', rpc_portal: '127.0.0.1:15999' }
}
export const copyText = writeText
export const exitApplication = () => exit(0)
export const getLogDirPath = () => invoke<string>('get_log_dir_path')
export async function openLogDirectory() { if (osType() !== 'android') await open(await getLogDirPath()) }

export interface TrayLabels { show: string; exit: string }
let trayQueue: Promise<void> = Promise.resolve()
let trayVersion = ''
async function toggleWindow() {
  const window = getCurrentWindow()
  if (await window.isVisible()) await window.hide()
  else { await window.show(); await window.setFocus() }
}
async function configureTray(labels: TrayLabels, tooltip?: string) {
  let tray = await TrayIcon.getById('main')
  if (!tray) tray = await TrayIcon.new({ id: 'main', tooltip: `EasyTier ${trayVersion}`, action: () => { void toggleWindow().catch(() => undefined) } })
  await tray.setMenuOnLeftClick(false)
  await tray.setMenu(await Menu.new({ items: [
    await MenuItem.new({ id: 'show', text: labels.show, action: () => { void toggleWindow().catch(() => undefined) } }),
    await PredefinedMenuItem.new({ item: 'Separator' }),
    await PredefinedMenuItem.new({ text: labels.exit, item: 'Quit' }),
  ] }))
  await tray.setTooltip(`EasyTier ${trayVersion}${tooltip ? `\n${tooltip}` : ''}`)
}
export async function initializeDesktopTray(version: string, labels: TrayLabels = { show: 'Show / Hide', exit: 'Exit' }): Promise<void> {
  if (osType() === 'android') return
  trayVersion = version
  await getCurrentWindow().setTitle(`EasyTier ${version}`)
  await updateDesktopTray(labels)
}
export function updateDesktopTray(labels: TrayLabels, tooltip?: string): Promise<void> {
  if (osType() === 'android') return Promise.resolve()
  const run = trayQueue.catch(() => undefined).then(() => configureTray(labels, tooltip))
  trayQueue = run.catch(() => undefined)
  return run
}

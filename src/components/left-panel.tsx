import { getGamepadNavigationTrees, quickAccessMenuClasses } from "@decky/ui"
import { FC, ReactNode, useEffect, useState } from "react"

// Use the main window's CSS viewport, not the 1px shared JS context or the
// QAM popup's full-screen transparent backing surface. Meet its visible edge.
function panelBounds() {
  const trees = (getGamepadNavigationTrees() || []) as any[]
  const owner = (id: string) => {
    const tree = trees.find(t => (t.id ?? t.m_ID) === id)
    return tree?.Root?.Element?.ownerDocument?.defaultView ?? tree?.m_Root?.m_element?.ownerDocument?.defaultView
  }
  const host = window as any
  const main = host.SteamUIStore?.WindowStore?.GamepadUIMainWindowInstance
  const focused = host.SteamUIStore?.GetFocusedWindowInstance?.() ?? main
  const menu = focused?.MenuStore?.GetOpenSideMenu?.()
  const qam = owner("QuickAccess-NA")
  const tabs = qam?.document.querySelector(`[class~="${quickAccessMenuClasses.Tabs}"]`)
  const panels = qam?.document.querySelectorAll(`[class~="${quickAccessMenuClasses.TabGroupPanel}"]`)
  const contentWidth = (tabs?.getBoundingClientRect().width || 0) + Math.max(0, ...Array.from(panels || []).map((p: any) => p.getBoundingClientRect().width))
  const width = contentWidth > 0 ? contentWidth : 348
  const keyboard = focused?.VirtualKeyboardManager?.IsShowingVirtualKeyboard?.Value
  const blocked = main?.GetShowingGlobalModal?.() || main?.ModalManager?.active_modal || main?.LocationPathName === "/error" || main?.BViewingPreLoginRoute?.()
  const viewport = owner("GamepadUI_Full_Root") || owner("root_1_")
  const viewportWidth = viewport?.innerWidth > 1 ? viewport.innerWidth : window.innerWidth > 1 ? window.innerWidth : 854
  const viewportHeight = viewport?.innerHeight > 1 ? viewport.innerHeight : window.innerHeight > 1 ? window.innerHeight : 534
  const availableWidth = Math.max(0, viewportWidth - width)
  return { visible: (menu === undefined ? qam && !qam.document.hidden : menu === 2) && !blocked,
    width: availableWidth, height: Math.max(0, viewportHeight - (keyboard ? 240 : 0)) }
}
export const LeftPanel: FC<{ children: ReactNode }> = ({ children }) => {
  const [bounds, setBounds] = useState(panelBounds)
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = panelBounds()
      setBounds(old => old.visible === next.visible && old.width === next.width && old.height === next.height ? old : next)
    }, 100)
    return () => window.clearInterval(timer)
  }, [])
  return <div aria-label="UmeYc-SteamBack 左侧存档面板" style={{ position: "absolute", zIndex: 7001,
    left: 0, top: 0, width: bounds.width, height: bounds.height, display: bounds.visible ? "block" : "none",
    overflow: "hidden", pointerEvents: "auto", background: "#101720", color: "white" }}>{children}</div>
}

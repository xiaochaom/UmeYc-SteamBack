// Match compatibility tool names, without hiding games such as Proton Pulse.
export function isCompatibilityTool(name: string): boolean {
  const value = name.trim()
  return /^(?:proton(?:\s*[-_]\s*|\s+)?(?:\d[\w.\s-]*|experimental|hotfix|next|bleeding[ -]edge)|(?:ge[-_ ]?proton|proton[-_ ]?ge)(?:[-_ ]?\d[\w.\s-]*)?|steam linux runtime(?:\s*[-_]\s*|\s+)?(?:\d[\w.\s-]*(?:\([a-z]+\))?|soldier|sniper|scout)?|proton)$/i.test(value)
}

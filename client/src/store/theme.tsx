import { createContext, useContext, useEffect, useState } from 'react'

export type Theme = 'default' | 'cyberpunk' | 'nord' | 'dracula' | 'sunset' | 'light' | 'windows' | 'blueprint' | 'system'

export const THEMES: { id: Theme; label: string; accent: string }[] = [
  { id: 'system',    label: 'System',    accent: '#888888' },
  { id: 'default',   label: 'Dark',      accent: '#3b82f6' },
  { id: 'blueprint', label: 'Blueprint', accent: '#63b3ed' },
  { id: 'light',     label: 'Light',     accent: '#0078D4' },
  { id: 'windows',   label: 'Win Dark',  accent: '#0078D4' },
  { id: 'nord',      label: 'Nord',      accent: '#88C0D0' },
  { id: 'dracula',   label: 'Dracula',   accent: '#BD93F9' },
  { id: 'sunset',    label: 'Sunset',    accent: '#F59E0B' },
  { id: 'cyberpunk', label: 'Cyberpunk', accent: '#FF0080' },
]

const VALID: Theme[] = ['default', 'cyberpunk', 'nord', 'dracula', 'sunset', 'light', 'windows', 'blueprint', 'system']

const Ctx = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: 'system',
  setTheme: () => {},
})

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem('theme')
    return VALID.includes(stored as Theme) ? (stored as Theme) : 'system'
  })

  const setTheme = (t: Theme) => {
    setThemeState(t)
    localStorage.setItem('theme', t)
  }

  useEffect(() => {
    if (theme === 'system') {
      const apply = () => {
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
        document.documentElement.setAttribute('data-theme', dark ? 'windows' : 'light')
      }
      apply()
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    } else {
      document.documentElement.setAttribute('data-theme', theme)
    }
  }, [theme])

  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>
}

export const useTheme = () => useContext(Ctx)

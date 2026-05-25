import { createContext, useContext, useEffect, useState } from 'react'

export type Theme = 'default' | 'cyberpunk' | 'nord' | 'dracula' | 'sunset'

export const THEMES: { id: Theme; label: string; accent: string }[] = [
  { id: 'default',   label: 'Default',   accent: '#3b82f6' },
  { id: 'nord',      label: 'Nord',      accent: '#88C0D0' },
  { id: 'dracula',   label: 'Dracula',   accent: '#BD93F9' },
  { id: 'sunset',    label: 'Sunset',    accent: '#F59E0B' },
  { id: 'cyberpunk', label: 'Cyberpunk', accent: '#FF0080' },
]

const VALID: Theme[] = ['default', 'cyberpunk', 'nord', 'dracula', 'sunset']

const Ctx = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: 'default',
  setTheme: () => {},
})

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem('theme')
    return VALID.includes(stored as Theme) ? (stored as Theme) : 'default'
  })

  const setTheme = (t: Theme) => {
    setThemeState(t)
    localStorage.setItem('theme', t)
  }

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>
}

export const useTheme = () => useContext(Ctx)

import { createContext, useContext, useEffect, useState } from 'react'

export type Theme = 'default' | 'cyberpunk'

export const THEMES: { id: Theme; label: string; accent: string }[] = [
  { id: 'default',   label: 'Default',   accent: '#3b82f6' },
  { id: 'cyberpunk', label: 'Cyberpunk', accent: '#00f5d4' },
]

const Ctx = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: 'default',
  setTheme: () => {},
})

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem('theme') as Theme) || 'default'
  )

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

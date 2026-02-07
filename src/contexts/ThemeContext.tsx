import React, { createContext, useState, useContext, useCallback, useEffect, useRef } from 'react';
import { api } from '../lib/api';

export type ThemeMode = 'dark' | 'gray' | 'light' | 'custom';
export type ThemePreference = ThemeMode | 'system';

export interface CustomThemeColors {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
}

interface ThemeContextType {
  theme: ThemeMode;
  themePreference: ThemePreference;
  customColors: CustomThemeColors;
  setTheme: (theme: ThemePreference) => Promise<void>;
  setCustomColors: (colors: Partial<CustomThemeColors>) => Promise<void>;
  isLoading: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_STORAGE_KEY = 'theme_preference';
const CUSTOM_COLORS_STORAGE_KEY = 'theme_custom_colors';

const getSystemTheme = (): 'dark' | 'light' => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const isThemePreference = (value: string | null): value is ThemePreference => {
  return value === 'dark' || value === 'gray' || value === 'light' || value === 'custom' || value === 'system';
};

// Default custom theme colors (based on current dark theme)
const DEFAULT_CUSTOM_COLORS: CustomThemeColors = {
  background: 'oklch(0.12 0.01 240)',
  foreground: 'oklch(0.98 0.01 240)',
  card: 'oklch(0.14 0.01 240)',
  cardForeground: 'oklch(0.98 0.01 240)',
  primary: 'oklch(0.98 0.01 240)',
  primaryForeground: 'oklch(0.12 0.01 240)',
  secondary: 'oklch(0.16 0.01 240)',
  secondaryForeground: 'oklch(0.98 0.01 240)',
  muted: 'oklch(0.16 0.01 240)',
  mutedForeground: 'oklch(0.65 0.01 240)',
  accent: 'oklch(0.16 0.01 240)',
  accentForeground: 'oklch(0.98 0.01 240)',
  destructive: 'oklch(0.6 0.2 25)',
  destructiveForeground: 'oklch(0.98 0.01 240)',
  border: 'oklch(0.16 0.01 240)',
  input: 'oklch(0.16 0.01 240)',
  ring: 'oklch(0.98 0.01 240)',
};

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeMode>(() => getSystemTheme());
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>('system');
  const [customColors, setCustomColorsState] = useState<CustomThemeColors>(DEFAULT_CUSTOM_COLORS);
  const [isLoading, setIsLoading] = useState(true);
  const themePreferenceRef = useRef<ThemePreference>('system');
  const customColorsRef = useRef<CustomThemeColors>(DEFAULT_CUSTOM_COLORS);

  useEffect(() => {
    themePreferenceRef.current = themePreference;
  }, [themePreference]);

  useEffect(() => {
    customColorsRef.current = customColors;
  }, [customColors]);

  // Apply theme to document
  const applyTheme = useCallback((themeMode: ThemeMode, colors: CustomThemeColors) => {
    const root = document.documentElement;
    
    // Remove all theme classes
    root.classList.remove('theme-dark', 'theme-gray', 'theme-light', 'theme-custom');
    
    // Add new theme class
    root.classList.add(`theme-${themeMode}`);
    
    // If custom theme, apply custom colors as CSS variables
    if (themeMode === 'custom') {
      Object.entries(colors).forEach(([key, value]) => {
        const cssVarName = `--color-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
        root.style.setProperty(cssVarName, value);
      });
    } else {
      // Clear custom CSS variables when not using custom theme
      Object.keys(colors).forEach((key) => {
        const cssVarName = `--color-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
        root.style.removeProperty(cssVarName);
      });
    }

    if (themeMode === 'light') {
      root.style.colorScheme = 'light';
    } else {
      root.style.colorScheme = 'dark';
    }

    // Note: Window theme updates removed since we're using custom titlebar
  }, []);

  // Load theme preference and custom colors from storage
  useEffect(() => {
    let isMounted = true;

    const loadTheme = async () => {
      try {
        // Load custom colors
        const savedColors = await api.getSetting(CUSTOM_COLORS_STORAGE_KEY);
        let nextCustomColors = DEFAULT_CUSTOM_COLORS;
        
        if (savedColors) {
          try {
            nextCustomColors = JSON.parse(savedColors) as CustomThemeColors;
          } catch (parseError) {
            console.error('Failed to parse custom theme settings:', parseError);
          }
        }

        if (isMounted) {
          setCustomColorsState(nextCustomColors);
          customColorsRef.current = nextCustomColors;
        }

        // Load theme preference
        const savedTheme = await api.getSetting(THEME_STORAGE_KEY);
        const nextThemePreference: ThemePreference = isThemePreference(savedTheme) ? savedTheme : 'system';
        const resolvedTheme: ThemeMode = nextThemePreference === 'system' ? getSystemTheme() : nextThemePreference;

        if (isMounted) {
          document.documentElement.classList.remove('warp-default');
          themePreferenceRef.current = nextThemePreference;
          setThemePreferenceState(nextThemePreference);
          setThemeState(resolvedTheme);
          applyTheme(resolvedTheme, nextCustomColors);
        }

        if (!isThemePreference(savedTheme)) {
          await api.saveSetting(THEME_STORAGE_KEY, 'system');
        }
      } catch (error) {
        console.error('Failed to load theme settings:', error);
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    loadTheme();

    return () => {
      isMounted = false;
    };
  }, [applyTheme]);

  // Listen for system theme changes only once and apply when preference is "system"
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (themePreferenceRef.current !== 'system') {
        return;
      }
      const nextTheme: ThemeMode = mediaQuery.matches ? 'dark' : 'light';
      setThemeState(nextTheme);
      applyTheme(nextTheme, customColorsRef.current);
    };

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
    } else if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(handleChange);
    }

    return () => {
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handleChange);
      } else if (typeof mediaQuery.removeListener === 'function') {
        mediaQuery.removeListener(handleChange);
      }
    };
  }, [applyTheme]);

  const setTheme = useCallback(async (newThemePreference: ThemePreference) => {
    try {
      setIsLoading(true);
      document.documentElement.classList.remove('warp-default');
      
      // Apply theme immediately
      themePreferenceRef.current = newThemePreference;
      setThemePreferenceState(newThemePreference);
      const resolvedTheme: ThemeMode = newThemePreference === 'system' ? getSystemTheme() : newThemePreference;
      setThemeState(resolvedTheme);
      applyTheme(resolvedTheme, customColorsRef.current);
      
      // Save to storage
      await api.saveSetting(THEME_STORAGE_KEY, newThemePreference);
    } catch (error) {
      console.error('Failed to save theme preference:', error);
    } finally {
      setIsLoading(false);
    }
  }, [applyTheme]);

  const setCustomColors = useCallback(async (colors: Partial<CustomThemeColors>) => {
    try {
      setIsLoading(true);
      
      const newColors = { ...customColors, ...colors };
      customColorsRef.current = newColors;
      setCustomColorsState(newColors);
      
      // Apply immediately if custom theme is active
      if (themePreference === 'custom') {
        setThemeState('custom');
        applyTheme('custom', newColors);
      }
      
      // Save to storage
      await api.saveSetting(CUSTOM_COLORS_STORAGE_KEY, JSON.stringify(newColors));
    } catch (error) {
      console.error('Failed to save custom colors:', error);
    } finally {
      setIsLoading(false);
    }
  }, [themePreference, customColors, applyTheme]);

  const value: ThemeContextType = {
    theme,
    themePreference,
    customColors,
    setTheme,
    setCustomColors,
    isLoading,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useThemeContext = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useThemeContext must be used within a ThemeProvider');
  }
  return context;
};

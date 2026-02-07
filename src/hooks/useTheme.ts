import { useThemeContext } from '../contexts/ThemeContext';

/**
 * Hook to access and control the theme system
 * 
 * @returns {Object} Theme utilities and state
 * @returns {ThemePreference} themePreference - Saved theme preference ('system' | 'dark' | 'gray' | 'light' | 'custom')
 * @returns {ThemeMode} theme - Current resolved/applied theme ('dark' | 'gray' | 'light' | 'custom')
 * @returns {CustomThemeColors} customColors - Custom theme color configuration
 * @returns {Function} setTheme - Function to change the theme preference
 * @returns {Function} setCustomColors - Function to update custom theme colors
 * @returns {boolean} isLoading - Whether theme operations are in progress
 * 
 * @example
 * const { theme, setTheme } = useTheme();
 * 
 * // Change theme
 * await setTheme('system');
 * 
 * // Update custom colors
 * await setCustomColors({ background: 'oklch(0.98 0.01 240)' });
 */
export const useTheme = () => {
  return useThemeContext();
};

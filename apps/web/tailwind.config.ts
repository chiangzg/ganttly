import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'media', // PRD §2.9: follow system `prefers-color-scheme`
  theme: {
    extend: {
      colors: {
        // CSS-variable driven palette so dark mode is automatic via the
        // `.dark` class on <html> OR @media (prefers-color-scheme: dark).
        bg: 'rgb(var(--color-bg) / <alpha-value>)',
        'bg-elevated': 'rgb(var(--color-bg-elevated) / <alpha-value>)',
        border: 'rgb(var(--color-border) / <alpha-value>)',
        fg: 'rgb(var(--color-fg) / <alpha-value>)',
        'fg-muted': 'rgb(var(--color-fg-muted) / <alpha-value>)',
        primary: 'rgb(var(--color-primary) / <alpha-value>)',
        accent: 'rgb(var(--color-accent) / <alpha-value>)',
        danger: 'rgb(var(--color-danger) / <alpha-value>)',
        success: 'rgb(var(--color-success) / <alpha-value>)',
        warning: 'rgb(var(--color-warning) / <alpha-value>)',
        'non-working': 'rgb(var(--color-non-working) / <alpha-value>)',
        'task-bar': 'rgb(var(--color-task-bar) / <alpha-value>)',
        'task-progress': 'rgb(var(--color-task-progress) / <alpha-value>)',
        critical: 'rgb(var(--color-critical) / <alpha-value>)',
      },
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'PingFang SC',
          'Microsoft YaHei',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
} satisfies Config;

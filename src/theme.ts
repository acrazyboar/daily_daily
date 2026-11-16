export const DEFAULT_THEME = "#486b48";
export const THEME_KEY = "daily-log.theme-color";
export const THEMES = [
  { name: "森林绿", color: DEFAULT_THEME },
  { name: "海湾蓝", color: "#426d9a" },
  { name: "暮光紫", color: "#796094" },
  { name: "暖陶橙", color: "#a5683e" },
  { name: "玫瑰粉", color: "#a35d78" },
];
export function readTheme(): string {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value && /^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  } catch { /* An unavailable preference store must not block startup. */ }
  return DEFAULT_THEME;
}
export function applyTheme(color: string) {
  const channels = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels;
  const max = Math.max(...channels), min = Math.min(...channels), delta = max - min;
  const hue = delta === 0 ? 115 : max === r
    ? ((g - b) / delta * 60 + 360) % 360
    : max === g ? (b - r) / delta * 60 + 120 : (r - g) / delta * 60 + 240;
  const linear = channels.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  const root = document.documentElement;
  root.style.setProperty("--theme-hue", `${Math.round(hue)}deg`);
  root.style.setProperty("--accent", color);
  root.style.setProperty("--accent-ink", luminance > .179 ? "#000000" : "#ffffff");
}

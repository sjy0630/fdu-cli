/** 用登录会话读校内页面；被带到登录页时抛出 NeedLoginError */
export interface CampusReader {
  getText(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ url: string; status: number; text: string }>;
  /** 页面靠脚本加载内容时，在无界面浏览器里渲染后再读（测试里可以不提供） */
  render?(url: string, ready: (html: string, url: string) => boolean): Promise<string>;
}

/** weekday：1 = 周一 … 7 = 周日；时间为 HH:MM */
export interface CourseSlot { weekday: number; start: string; end: string; location?: string; weeks?: number[] }

/** 上海时间（UTC+8，无夏令时）的年月日时分 → ISO 字符串 */
export function shanghai(y: number, mo: number, d: number, h = 0, mi = 0): string {
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi)).toISOString();
}

import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Server emits paths like "/icons/foo.png" for files in client-aac/public/icons.
// Vite's base is "/aac/" in production and "./" in Electron, so the leading-slash
// form 404s outside of dev. Rewrite against BASE_URL at the render site.
export function resolveStaticIconPath(src: string): string {
  if (src.startsWith("/icons/")) {
    return `${import.meta.env.BASE_URL}${src.slice(1)}`;
  }
  return src;
}

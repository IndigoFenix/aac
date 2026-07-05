import type { CookieOptions } from '../types/interfaces';

/**
 * Static utility class for browser cookie management
 */
export class CookieManager {
	/**
	 * Set a cookie with optional expiration
	 */
	static setCookie({ name = "", days = 0, value = "", path = "/" }: CookieOptions): void {
		let expire = "";
		if (days) {
			const date = new Date();
			date.setTime(date.getTime() + days * 1000 * 60 * 60 * 24);
			expire = date.toUTCString();
		}
		document.cookie = `${name}=${value}; expires=${expire}; path=${path}`;
	}

	/**
	 * Get a cookie value by name
	 * @returns Cookie value or null if not found
	 */
	static getCookie({ name }: { name: string }): string | null {
		name = name.trim();
		const allCookie = document.cookie;
		const cookieArr = allCookie.split(";");

		for (let i = 0; i < cookieArr.length; i++) {
			const c = cookieArr[i].trim();
			if (c.startsWith(`${name}=`)) {
				return c.split("=")[1];
			}
		}
		return null;
	}

	/**
	 * Remove a cookie by setting expiration to past
	 */
	static removeCookie({ name = "" }: { name: string }): void {
		CookieManager.setCookie({ name, days: -1 });
	}

	/**
	 * Check if a cookie exists and has a value
	 */
	static checkCookie({ name = "" }: { name: string }): boolean {
		const cookie = CookieManager.getCookie({ name });
		return cookie !== undefined && cookie !== "" && cookie !== null;
	}
}

export default CookieManager;

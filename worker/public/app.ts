/**
 * Canvas Mini App — Shell placeholder
 *
 * Imports the Telegram WebApp SDK, initializes the shell,
 * and will later render session picker / artifact gallery.
 */

import "./types.ts";

const webapp = (window as any).Telegram?.WebApp;

if (webapp) {
	webapp.ready();
	webapp.expand();
}

document.querySelector<HTMLDivElement>("#app")!.textContent = "Canvas — connecting…";

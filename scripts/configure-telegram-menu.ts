/**
 * Configure the Telegram bot menu button to open Canvas.
 *
 * Usage:
 *   export TELEGRAM_BOT_TOKEN="..."
 *   npx tsx scripts/configure-telegram-menu.ts
 *
 * This sets the global bot menu button to open
 * https://canvas.advaitdeshpande.com as a WebApp.
 * Run once after initial setup and after bot token rotation.
 *
 * Does not print the bot token — only the response status.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
	console.error("TELEGRAM_BOT_TOKEN environment variable is not set");
	process.exit(1);
}

const CANVAS_URL = "https://canvas.advaitdeshpande.com";

async function main(): Promise<void> {
	// Set the global menu button
	const url = `https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`;

	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			menu_button: {
				type: "web_app",
				text: "canvas",
				web_app: { url: CANVAS_URL },
			},
		}),
	});

	const body = await response.json();

	if (body.ok) {
		console.log("✓ Canvas menu button configured successfully");
		console.log("  The 'canvas' button will appear in the bot's menu.");
		console.log(`  It opens ${CANVAS_URL}`);
	} else {
		console.error("✗ Failed to set menu button:", body.description ?? "Unknown error");
		process.exit(1);
	}

	// Also verify the current configuration
	const checkUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMenuButton`;
	const checkResp = await fetch(checkUrl);
	const checkBody = await checkResp.json();
	if (checkBody.ok) {
		const btn = checkBody.result?.menu_button ?? {};
		console.log(`\nCurrent menu button: ${JSON.stringify(btn)}`);
	}
}

main().catch((err) => {
	console.error("Script failed:", err.message);
	process.exit(1);
});

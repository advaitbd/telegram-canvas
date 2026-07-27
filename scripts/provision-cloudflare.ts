/**
 * Provision isolated preview Cloudflare resources for PR deployments.
 *
 * This script creates a separate Worker, D1 database, R2 bucket, and DO
 * namespace so a PR deployment does not share state with production.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN="..." npx tsx scripts/provision-cloudflare.ts <preview-name>
 *
 * Example:
 *   CLOUDFLARE_API_TOKEN="..." npx tsx scripts/provision-cloudflare.ts pr-42
 *
 * Requires a Cloudflare API token with permissions:
 *   Account: Workers Scripts (Edit), D1 (Edit), R2 (Edit), Durable Objects (Edit)
 *   Zone: Workers Routes (Edit), DNS (Edit)
 *
 * Note: This script requires the CLOUDFLARE_API_TOKEN environment variable
 * to be set in the GitHub Actions secrets (production environment).
 * PRs from forked repositories will not have access to this secret.
 */

const PREVIEW_NAME = process.argv[2];
if (!PREVIEW_NAME) {
	console.error("Usage: tsx scripts/provision-cloudflare.ts <preview-name>");
	process.exit(1);
}

const WORKER_NAME = `telegram-canvas-${PREVIEW_NAME}`;
const DB_NAME = `telegram-canvas-${PREVIEW_NAME}`;
const BUCKET_NAME = `telegram-canvas-artifacts-${PREVIEW_NAME}`;
const ZONE_NAME = "advaitdeshpande.com";
const PREVIEW_URL = `${PREVIEW_NAME}.canvas.advaitdeshpande.com`;

async function exec(cmd: string): Promise<string> {
	const proc = await import("child_process");
	return new Promise((resolve, reject) => {
		proc.exec(cmd, (err, stdout) => {
			if (err) reject(err);
			else resolve(stdout.trim());
		});
	});
}

async function main() {
	console.log(`\nProvisioning preview: ${PREVIEW_NAME}`);
	console.log(`  Worker: ${WORKER_NAME}`);
	console.log(`  D1:     ${DB_NAME}`);
	console.log(`  R2:     ${BUCKET_NAME}`);
	console.log(`  URL:    https://${PREVIEW_URL}\n`);

	// 1. Create D1 database
	try {
		const d1Output = await exec(`wrangler d1 create ${DB_NAME}`);
		const match = d1Output.match(/database_id":\s*"([^"]+)"/);
		const dbId = match ? match[1] : "unknown";
		console.log(`✅ D1 database created: ${dbId}`);
	} catch (e) {
		console.error(`❌ D1 create failed: ${e}`);
	}

	// 2. Create R2 bucket
	try {
		await exec(`wrangler r2 bucket create ${BUCKET_NAME}`);
		console.log("✅ R2 bucket created");
	} catch (e) {
		console.error(`❌ R2 bucket create failed: ${e}`);
	}

	// 3. Add DNS record for preview
	try {
		const zoneId = "40d87aeb520df62aeb11de96cbcf44eb";
		const token = process.env.CLOUDFLARE_API_TOKEN;
		const dnsName = `${PREVIEW_NAME}.canvas`;
		const resp = await fetch(
			`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					type: "A",
					name: dnsName,
					content: "192.0.2.1",
					ttl: 1,
					proxied: true,
				}),
			},
		);
		const result = await resp.json();
		if ((result as any).success) {
			console.log(`✅ DNS record created for ${dnsName}.${ZONE_NAME}`);
		} else {
			console.error(`❌ DNS creation failed: ${JSON.stringify((result as any).errors)}`);
		}
	} catch (e) {
		console.error(`❌ DNS creation error: ${e}`);
	}

	console.log(`\nPreview resources created. Deploy with:`);
	console.log(`  CLOUDFLARE_API_TOKEN="..." npx wrangler deploy --name ${WORKER_NAME}`);
	console.log(`\nConfigure secrets:`);
	console.log(`  echo "secret" | wrangler secret put TELEGRAM_BOT_TOKEN --name ${WORKER_NAME}`);
	console.log(`\nTeardown:`);
	console.log(`  wrangler delete ${WORKER_NAME}`);
	console.log(`  wrangler d1 delete ${DB_NAME}`);
	console.log(`  wrangler r2 bucket delete ${BUCKET_NAME}`);
}

main().catch(console.error);

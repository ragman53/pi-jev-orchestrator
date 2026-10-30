import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CredentialInfo,
	type CredentialStore,
	getSupportedThinkingLevels,
	InMemoryModelsStore,
	type ModelsStoreEntry,
} from "@earendil-works/pi-ai";
import {
	getAgentDir,
	ModelRegistry,
	ModelRuntime,
	readStoredCredential,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.ts";
import { resolveTarget } from "../src/policy.ts";
import { thinkingCacheAssessment } from "../src/thinking.ts";

/** Read existing catalog/credential metadata without changing files or refreshing tokens. */
export async function audit() {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const store = new InMemoryModelsStore();
	let cached: Record<string, ModelsStoreEntry> = {};
	try {
		cached = JSON.parse(readFileSync(join(agentDir, "models-store.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new Error("Cannot read the catalog snapshot for the audit.");
	}
	for (const [provider, entry] of Object.entries(cached)) await store.write(provider, entry);
	const providers = [...new Set([...Object.keys(cached), "openai", "openai-codex", "typesafe", "deepseek"])];
	const credentials: CredentialStore = {
		async read(provider) {
			return readStoredCredential(provider, authPath);
		},
		async list() {
			return providers.flatMap((providerId) => {
				const credential = readStoredCredential(providerId, authPath);
				return credential ? [{ providerId, type: credential.type } satisfies CredentialInfo] : [];
			});
		},
		async modify() {
			throw new Error("Credential refresh is disabled in the read-only audit.");
		},
		async delete() {
			throw new Error("Credential writes are disabled in the read-only audit.");
		},
	};
	const runtime = await ModelRuntime.create({ credentials, modelsStore: store, allowModelNetwork: false });
	const registry = new ModelRegistry(runtime);
	const config = loadConfig();
	const models = [];
	for (const role of ["terra", "sol", "astra", "fallback"] as const) {
		const selected = resolveTarget(role, config, registry);
		const target = config.models[role];
		const known = target
			? [target.preferred, ...target.compatible].flatMap((key) => {
					const i = key.indexOf("/");
					const m = registry.find(key.slice(0, i), key.slice(i + 1));
					return m
						? [
								{
									key,
									authenticated: registry.hasConfiguredAuth(m),
									api: m.api,
									levels: getSupportedThinkingLevels(m),
								},
							]
						: [];
				})
			: [];
		models.push({
			role,
			selected: selected ? `${selected.provider}/${selected.id}` : null,
			disabled: target === null,
			known,
			thinkingCache: selected ? await thinkingCacheAssessment(selected, registry) : null,
		});
	}
	const authenticatedGptVariants = registry
		.getAvailable()
		.filter((m) => ["gpt-6.1-terra", "gpt-5.6-terra", "gpt-6.1-sol", "gpt-6-astra"].includes(m.id))
		.map((m) => ({
			model: `${m.provider}/${m.id}`,
			levels: getSupportedThinkingLevels(m),
			oauth: registry.isUsingOAuth(m),
		}));
	return {
		piVersion: VERSION,
		requestsSent: 0,
		credentialWrites: 0,
		authenticatedGptVariants,
		catalog: "Installed static catalog plus the local cache; no remote refresh.",
		models,
	};
}
if (import.meta.main) console.log(JSON.stringify(await audit(), null, 2));

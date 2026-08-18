import { Provider } from "../provider";
import { Notice, Setting, debounce, requestUrl } from "obsidian";
import { debugLog } from "../../util";
import { Models } from "../types";
import { notifyModelsChange, possibleModels } from "../globals";
import AIImageAnalyzerPlugin from "../../main";
import { saveSettings, settings } from "../../settings";

const context = "ai-adapter/providers/llamaCppProvider";

export type LlamaCppSettings = {
	lastModel: Models;
	lastImageModel: Models;
	url: string;
	token: string;
	temperature: number;
	/** Modelnaam in de request-body. Leeg laten voor llama-server, dat één model
	 * laadt en het veld negeert; OpenAI-compatible gateways (Bifrost, vLLM,
	 * LiteLLM) eisen het juist. */
	model: string;
};

// llama.cpp use local model
const LLAMA_CPP_MODEL: Models = {
	name: "llama.cpp (GGUF)",
	model: "local-gguf-model",
	imageReady: true,
	provider: "llama-cpp",
};

export const DEFAULT_LLAMA_CPP_SETTINGS: LlamaCppSettings = {
	lastModel: LLAMA_CPP_MODEL,
	lastImageModel: LLAMA_CPP_MODEL,
	url: "http://127.0.0.1:8080",
	token: "",
	temperature: 0.7,
	model: "",
};

function getLlamaCppSettings(): LlamaCppSettings {
	if (!settings.aiAdapterSettings.llamaCppSettings) {
		settings.aiAdapterSettings.llamaCppSettings = {
			...DEFAULT_LLAMA_CPP_SETTINGS,
		};
	}

	return settings.aiAdapterSettings.llamaCppSettings;
}

export class LlamaCppProvider extends Provider {
	/** requestUrl kent geen AbortSignal. Annuleren gebeurt daarom met een
	 * generatieteller: het lopende verzoek loopt door, maar zodra de teller is
	 * opgeschoven wordt het antwoord verworpen met een AbortError — dezelfde
	 * semantiek als voorheen voor alles wat de caller ziet. */
	private static generation = 0;

	constructor() {
		super();
		const llamaCppSettings = getLlamaCppSettings();
		this.lastModel = llamaCppSettings.lastModel;
		this.lastImageModel = llamaCppSettings.lastImageModel;
	}

	/** Verbindingstest, uitgesteld tot 800 ms na de laatste wijziging. */
	private debouncedCheckConnection = debounce(
		() => {
			void this.checkConnection().then((success) => {
				debugLog(context, "llama.cpp check success: " + success);
			});
		},
		800,
		true,
	);

	async initialize(): Promise<boolean> {
		const success = await this.checkConnection();
		debugLog(context, "llama.cpp check success: " + success);
		return success;
	}

	generateSettings(containerEl: HTMLElement, plugin: AIImageAnalyzerPlugin) {
		const llamaCppSettings = getLlamaCppSettings();

		new Setting(containerEl)
			.setName("Llama.cpp (llama-server)")
			.setHeading();

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc(
				"Set the URL for the llama-server (by default use `http://127.0.0.1:8080`)",
			)
			.addText((text) =>
				text
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					.setPlaceholder("http://127.0.0.1:8080")
					.setValue(llamaCppSettings.url)
					.onChange(async (value) => {
						if (value.length === 0) {
							value = DEFAULT_LLAMA_CPP_SETTINGS.url;
						}
						llamaCppSettings.url = value;
						// Debounce: zonder dit vuurt er een verbindingstest per
						// toetsaanslag, wat bij het intypen van een URL tientallen
						// mislukte requests oplevert zolang de waarde nog
						// onvolledig is.
						this.debouncedCheckConnection();
						await saveSettings(plugin);
					}),
			);

		new Setting(containerEl)
			.setName("API token (optional)")
			.setDesc(
				"Set the token used to authenticate with the llama-server (if required)",
			)
			.addText((text) =>
				text
					.setValue(llamaCppSettings.token !== "" ? "••••••••••" : "")
					.onChange(async (value) => {
						if (value.includes("•")) {
							return;
						}
						llamaCppSettings.token = value;
						await saveSettings(plugin);
					}),
			);

		new Setting(containerEl)
			.setName("Model (optional)")
			.setDesc(
				"Model name sent in the request body. Leave empty for llama-server, which loads a single model. OpenAI-compatible gateways (Bifrost, vLLM, LiteLLM) require it, e.g. `gemma4:26b`.",
			)
			.addText((text) =>
				text
					.setPlaceholder("gemma4:26b")
					.setValue(llamaCppSettings.model)
					.onChange(async (value) => {
						llamaCppSettings.model = value.trim();
						await saveSettings(plugin);
					}),
			);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Test the connection to llama-server")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					const success = await this.checkConnection();
					if (success) {
						new Notice("Successfully connected to llama-server!");
					} else {
						new Notice("Failed to connect to llama-server.");
					}
				}),
			);

		let tempSpan: HTMLSpanElement;
		new Setting(containerEl)
			.setName("Temperature")
			.setDesc(
				"Controls randomness in model output (0–2). Lower values produce more deterministic responses.",
			)
			.addSlider((slider) => {
				slider
					.setLimits(0, 2, 0.1)
					.setValue(llamaCppSettings.temperature)
					.onChange(async (value) => {
						llamaCppSettings.temperature = value;
						await saveSettings(plugin);
					});
				tempSpan = slider.sliderEl.parentElement!.createEl("span");
				tempSpan.textContent = llamaCppSettings.temperature.toFixed(1);
				slider.sliderEl.addEventListener("input", () => {
					tempSpan.textContent = parseFloat(
						slider.sliderEl.value,
					).toFixed(1);
				});
			});
	}

	async queryHandling(prompt: string): Promise<string> {
		const llamaCppSettings = getLlamaCppSettings();
		const url = `${llamaCppSettings.url}/v1/chat/completions`;
		const token = llamaCppSettings.token;

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (token) {
			headers["Authorization"] = `Bearer ${token}`;
		}

		LlamaCppProvider.abortCurrentRequest();
		const generation = ++LlamaCppProvider.generation;

		try {
			const response = await requestUrl({
				url,
				method: "POST",
				headers,
				body: JSON.stringify({
					...(llamaCppSettings.model
						? { model: llamaCppSettings.model }
						: {}),
					messages: [{ role: "user", content: prompt }],
					temperature: llamaCppSettings.temperature,
				}),
				throw: false,
			});

			LlamaCppProvider.throwIfSuperseded(generation);

			if (response.status < 200 || response.status >= 300) {
				throw new Error(
					`HTTP error! status: ${response.status}, ${response.text}`,
				);
			}

			return response.json?.choices?.[0]?.message?.content || "";
		} catch (e) {
			const errMsg =
				e instanceof Error
					? e.message
					: typeof e === "string"
						? e
						: (JSON.stringify(e) ?? String(e));
			debugLog(context, errMsg);
			if (e instanceof Error && e.name === "AbortError") {
				const abortErr = new Error("Request was aborted");
				abortErr.name = "AbortError";
				(abortErr as unknown as { cause?: unknown }).cause = e;
				throw abortErr;
			}
			const reErr = new Error(errMsg);
			(reErr as unknown as { cause?: unknown }).cause = e;
			throw reErr;
		}
	}

	async queryWithImageHandling(
		prompt: string,
		image: string,
	): Promise<string> {
		const llamaCppSettings = getLlamaCppSettings();
		const url = `${llamaCppSettings.url}/v1/chat/completions`;
		const token = llamaCppSettings.token;

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (token) {
			headers["Authorization"] = `Bearer ${token}`;
		}

		LlamaCppProvider.abortCurrentRequest();
		const generation = ++LlamaCppProvider.generation;

		try {
			// base64 picture
			const response = await requestUrl({
				url,
				method: "POST",
				headers,
				body: JSON.stringify({
					...(llamaCppSettings.model
						? { model: llamaCppSettings.model }
						: {}),
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: prompt },
								{
									type: "image_url",
									image_url: {
										url: `data:image/png;base64,${image}`,
									},
								},
							],
						},
					],
					temperature: llamaCppSettings.temperature,
				}),
				throw: false,
			});

			LlamaCppProvider.throwIfSuperseded(generation);

			if (response.status < 200 || response.status >= 300) {
				throw new Error(
					`HTTP error! status: ${response.status}, ${response.text}`,
				);
			}

			return response.json?.choices?.[0]?.message?.content || "";
		} catch (e) {
			const errMsg =
				e instanceof Error
					? e.message
					: typeof e === "string"
						? e
						: (JSON.stringify(e) ?? String(e));
			debugLog(context, errMsg);
			if (e instanceof Error && e.name === "AbortError") {
				const abortErr = new Error("Request was aborted");
				abortErr.name = "AbortError";
				(abortErr as unknown as { cause?: unknown }).cause = e;
				throw abortErr;
			}
			const reErr = new Error(errMsg);
			(reErr as unknown as { cause?: unknown }).cause = e;
			throw reErr;
		}
	}

	setLastModel(model: Models) {
		super.setLastModel(model);
		getLlamaCppSettings().lastModel = model;
	}

	setLastImageModel(model: Models) {
		super.setLastImageModel(model);
		getLlamaCppSettings().lastImageModel = model;
	}

	shutdown(): void {
		debugLog(context, "Shutting down llama.cpp provider");
		LlamaCppProvider.abortCurrentRequest();
	}

	private async checkConnection(): Promise<boolean> {
		const llamaCppSettings = getLlamaCppSettings();
		const token = llamaCppSettings.token;

		const headers: Record<string, string> = {};
		if (token) {
			headers["Authorization"] = `Bearer ${token}`;
		}

		// llama-server antwoordt op /health; OpenAI-compatible gateways
		// (Bifrost, vLLM, LiteLLM) kennen dat pad niet maar wel /v1/models.
		for (const path of ["/health", "/v1/models"]) {
			try {
				const response = await requestUrl({
					url: `${llamaCppSettings.url}${path}`,
					headers,
					throw: false,
				});
				if (response.status >= 200 && response.status < 300) {
					debugLog(
						context,
						`Successfully connected via ${path}`,
					);

					// ensure model list include llama.cpp's model
					if (
						!possibleModels.some((m) => m.provider === "llama-cpp")
					) {
						possibleModels.push(LLAMA_CPP_MODEL);
						notifyModelsChange();
					}

					return true;
				}
			} catch (e) {
				debugLog(context, `Failed to connect via ${path}: ` + e);
			}
		}
		return false;
	}

	static abortCurrentRequest(): void {
		LlamaCppProvider.generation++;
	}

	/** Gooit een AbortError wanneer er intussen een nieuwer verzoek is gestart of
	 * abortCurrentRequest() is aangeroepen. */
	private static throwIfSuperseded(generation: number): void {
		if (generation !== LlamaCppProvider.generation) {
			const abortErr = new Error("Request was aborted");
			abortErr.name = "AbortError";
			throw abortErr;
		}
	}
}

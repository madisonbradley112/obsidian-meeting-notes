import { requestUrl } from "obsidian";
import { PostProcessingProvider } from "./SettingsManager";

export interface PostProcessorConfig {
	apiKey: string;
	model: string;
	url: string;
	provider: PostProcessingProvider;
}

export class PostProcessor {
	private config: PostProcessorConfig;

	constructor(config: PostProcessorConfig) {
		this.config = config;
	}

	async process(text: string, prompt: string): Promise<string> {
		if (this.config.provider === "anthropic") {
			return this.callAnthropic(text, prompt);
		}
		return this.callOpenAI(text, prompt);
	}

	private async callOpenAI(text: string, prompt: string): Promise<string> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;

		const response = await requestUrl({
			url: this.config.url,
			method: "POST",
			headers,
			body: JSON.stringify({
				model: this.config.model,
				messages: [
					{ role: "system", content: prompt ?? "" },
					{ role: "user", content: text ?? "" },
				],
			}),
		});
		return response.json.choices[0].message.content.trim();
	}

	private async callAnthropic(text: string, prompt: string): Promise<string> {
		const response = await requestUrl({
			url: this.config.url,
			method: "POST",
			headers: {
				"x-api-key": this.config.apiKey,
				"anthropic-version": "2023-06-01",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: this.config.model,
				max_tokens: 8192,
				system: prompt,
				messages: [{ role: "user", content: text }],
			}),
		});
		return response.json.content[0].text;
	}
}

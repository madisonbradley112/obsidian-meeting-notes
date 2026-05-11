import { Notice, requestUrl } from "obsidian";
import { ChildProcess, spawn } from "child_process";
import { existsSync } from "fs";

export class ServerManager {
	private process: ChildProcess | null = null;
	private readonly serverDir: string;

	constructor(serverDir: string) {
		this.serverDir = serverDir;
	}

	startWhisper(): void {
		if (this.process) return;
		if (!existsSync(this.serverDir)) {
			new Notice(`✘ Whisper server directory not found:\n${this.serverDir}`);
			return;
		}
		try {
			this.process = spawn("bash", ["server.sh"], {
				cwd: this.serverDir,
				detached: false,
			});

			this.process.on("error", (err) => {
				console.error("[ServerManager] Whisper server error:", err);
				new Notice("✘ Whisper server failed to start");
				this.process = null;
			});

			this.process.on("exit", (code) => {
				if (code !== null && code !== 0) {
					console.error(`[ServerManager] Whisper server exited with code ${code}`);
				}
				this.process = null;
			});
		} catch (err) {
			console.error("Failed to spawn Whisper server:", err);
			new Notice("✘ Could not start Whisper server");
		}
	}

	stopWhisper(): void {
		if (!this.process) return;
		try {
			this.process.kill("SIGTERM");
		} catch (err) {
			console.error("[ServerManager] Error stopping Whisper server:", err);
		}
		this.process = null;
	}

	// Polls /health until the server responds 200 or timeout expires.
	// Returns true if ready, false if timed out.
	async waitUntilReady(healthUrl: string, timeoutMs = 90000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const res = await requestUrl({ url: healthUrl, method: "GET" });
				if (res.status === 200) return true;
			} catch {
				// server not up yet — keep polling
			}
			await new Promise((r) => setTimeout(r, 1500));
		}
		return false;
	}

	get isRunning(): boolean {
		return this.process !== null;
	}
}

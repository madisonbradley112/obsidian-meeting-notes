import { Notice, Plugin, TFile } from "obsidian";
import { join } from "path";
import { Timer } from "src/Timer";
import { Controls } from "src/Controls";
import { AudioHandler } from "src/AudioHandler";
import { WhisperSettingsTab } from "src/WhisperSettingsTab";
import { SettingsManager, PluginSettings } from "src/SettingsManager";
import { NativeAudioRecorder } from "src/AudioRecorder";
import { RecordingStatus, StatusBar } from "src/StatusBar";
import { ServerManager } from "src/ServerManager";
import { getExtensionFromMimeType } from "src/utils";
export default class Whisper extends Plugin {
	settings: PluginSettings;
	settingsManager: SettingsManager;
	timer: Timer;
	recorder: NativeAudioRecorder;
	audioHandler: AudioHandler;
	controls: Controls | null = null;
	statusBar: StatusBar;
	serverManager: ServerManager;

	async onload() {
		this.settingsManager = new SettingsManager(this);
		this.settings = await this.settingsManager.loadSettings();

		const adapter = this.app.vault.adapter as any;
		const vaultPath = adapter.getBasePath();
		const pluginDir = this.manifest.dir
			? join(vaultPath, this.manifest.dir)
			: join(vaultPath, ".obsidian", "plugins", this.manifest.id);
		const serverDir = join(pluginDir, "whisper-api-server");
		this.serverManager = new ServerManager(serverDir);

		this.addRibbonIcon("mic", "Open recording controls", () => {
			this.openControls();
		});

		this.addSettingTab(new WhisperSettingsTab(this.app, this));

		this.timer = new Timer();
		this.audioHandler = new AudioHandler(this);
		this.recorder = new NativeAudioRecorder();
		const deviceId =
			this.settings.audioDeviceId === "default"
				? null
				: this.settings.audioDeviceId;
		this.recorder.setDeviceId(deviceId);

		this.statusBar = new StatusBar(this);

		// Timer reacts to recording state changes
		this.statusBar.onChange((status) => {
			switch (status) {
				case RecordingStatus.Recording:
					this.timer.start();
					break;
				case RecordingStatus.Paused:
					this.timer.pause();
					break;
				case RecordingStatus.Processing:
				case RecordingStatus.Idle:
					this.timer.reset();
					break;
			}
		});

		this.addCommands();
		this.registerUriHandler();

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile)) return;

				const audioExtensions = [
					".mp3",
					".mp4",
					".mpeg",
					".mpga",
					".m4a",
					".wav",
					".webm",
					".ogg",
				];
				if (!audioExtensions.some((ext) => file.path.endsWith(ext)))
					return;

				menu.addItem((item) => {
					item.setTitle("Transcribe audio file 🔊")
						.setIcon("document")
						.onClick(async () => {
							const audioBlob = new Blob([
								await file.vault.readBinary(file),
							]);
							await this.audioHandler.sendAudioData(
								audioBlob,
								file.name
							);
						});
				});
			})
		);
	}

	onunload() {
		this.serverManager?.stopWhisper();
		if (this.controls) {
			this.controls.close();
		}
		this.statusBar.remove();
	}

	// --- Recording state transitions (single source of truth) ---

	async startRecording() {
		if (
			this.statusBar.status === RecordingStatus.Recording ||
			this.statusBar.status === RecordingStatus.Paused
		) {
			new Notice("Already recording");
			return;
		}
		// Start server in background so the model loads while recording
		this.serverManager.startWhisper();
		try {
			await this.recorder.startRecording();
			this.statusBar.updateStatus(RecordingStatus.Recording);
			new Notice("Recording...");
		} catch (err) {
			this.serverManager.stopWhisper();
			this.statusBar.updateStatus(RecordingStatus.Idle);
			new Notice("✘ Could not start recording");
		}
	}

	async stopRecording() {
		if (
			this.statusBar.status !== RecordingStatus.Recording &&
			this.statusBar.status !== RecordingStatus.Paused
		) {
			return;
		}
		this.statusBar.updateStatus(RecordingStatus.Processing);
		const audioBlob = await this.recorder.stopRecording();
		const extension = getExtensionFromMimeType(this.recorder.getMimeType());
		const fileName = `${new Date()
			.toISOString()
			.replace(/[:.]/g, "-")}.${extension}`;

		const healthUrl = this.whisperHealthUrl();
		new Notice("Waiting for Whisper server...");
		const ready = await this.serverManager.waitUntilReady(healthUrl);
		if (!ready) {
			new Notice("✘ Whisper server did not start in time");
			this.serverManager.stopWhisper();
			this.statusBar.updateStatus(RecordingStatus.Idle);
			return;
		}

		try {
			await this.audioHandler.sendAudioData(audioBlob, fileName);
		} finally {
			this.serverManager.stopWhisper();
			this.statusBar.updateStatus(RecordingStatus.Idle);
		}
	}

	async pauseRecording() {
		if (this.statusBar.status === RecordingStatus.Recording) {
			await this.recorder.pauseRecording();
			this.statusBar.updateStatus(RecordingStatus.Paused);
			new Notice("Recording paused");
		} else if (this.statusBar.status === RecordingStatus.Paused) {
			await this.recorder.pauseRecording();
			this.statusBar.updateStatus(RecordingStatus.Recording);
			new Notice("Recording resumed");
		}
	}

	async cancelRecording() {
		if (
			this.statusBar.status !== RecordingStatus.Recording &&
			this.statusBar.status !== RecordingStatus.Paused
		) {
			return;
		}
		await this.recorder.stopRecording();
		this.serverManager.stopWhisper();
		this.statusBar.updateStatus(RecordingStatus.Idle);
		new Notice("Recording cancelled");
	}

	openControls() {
		if (!this.controls) {
			this.controls = new Controls(this);
		}
		this.controls.open();
	}

	// Derives the health-check URL from the configured transcription API URL.
	private whisperHealthUrl(): string {
		try {
			const u = new URL(this.settings.apiUrl);
			u.pathname = "/health";
			u.search = "";
			return u.toString();
		} catch {
			return "http://localhost:5042/health";
		}
	}

	// --- Commands ---

	addCommands() {
		this.addCommand({
			id: "start-stop-recording",
			name: "Start/stop recording",
			callback: async () => {
				if (
					this.statusBar.status !== RecordingStatus.Recording &&
					this.statusBar.status !== RecordingStatus.Paused
				) {
					await this.startRecording();
				} else {
					await this.stopRecording();
				}
			},
			hotkeys: [{ modifiers: ["Alt"], key: "Q" }],
		});

		this.addCommand({
			id: "upload-audio-file",
			name: "Upload audio file",
			callback: () => {
				const fileInput = document.createElement("input");
				fileInput.type = "file";
				fileInput.accept =
					"audio/*,video/*,.mp4,.m4a,.wav,.webm,.ogg,.mp3";
				fileInput.onchange = async (event) => {
					const files = (event.target as HTMLInputElement).files;
					if (files && files.length > 0) {
						const file = files[0];
						const audioBlob = file.slice(0, file.size, file.type);
						this.serverManager.startWhisper();
						const ready = await this.serverManager.waitUntilReady(
							this.whisperHealthUrl()
						);
						if (!ready) {
							new Notice("✘ Whisper server did not start in time");
							this.serverManager.stopWhisper();
							return;
						}
						try {
							await this.audioHandler.sendAudioData(
								audioBlob,
								file.name
							);
						} finally {
							this.serverManager.stopWhisper();
						}
					}
				};
				fileInput.click();
			},
		});

		this.addCommand({
			id: "pause-resume-recording",
			name: "Pause/resume recording",
			callback: () => this.pauseRecording(),
		});

		this.addCommand({
			id: "open-recording-controls",
			name: "Open recording controls",
			callback: () => this.openControls(),
		});
	}

	// --- URI Handler ---

	registerUriHandler() {
		this.registerObsidianProtocolHandler("whisper", async (params) => {
			const command = params.command;
			if (!command) {
				this.openControls();
				return;
			}

			switch (command) {
				case "start":
					await this.startRecording();
					break;
				case "stop":
					await this.stopRecording();
					break;
				case "pause":
					await this.pauseRecording();
					break;
				case "cancel":
					await this.cancelRecording();
					break;
				default:
					new Notice(`✘ Unknown whisper command: ${command}`);
			}
		});
	}
}

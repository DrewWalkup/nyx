import {
	AI_PROVIDERS,
	DEFAULT_SYSTEM_PROMPT,
	SPEECH_TO_TEXT_PROVIDERS,
	STORAGE_KEYS,
	ISO_TO_RESPONSE_LANGUAGE,
	RESPONSE_LANGUAGE_TO_ISO,
} from "@/config";
import { getResponseSettings, updateLanguage as updateResponseLanguage } from "@/lib/storage/response-settings.storage";
import { getPlatform, safeLocalStorage } from "@/lib";
import { getShortcutsConfig } from "@/lib/storage";
import {
	getCustomizableState,
	setCustomizableState,
	updateAppIconVisibility,
	updateAlwaysOnTop,
	updateAutostart,
	CustomizableState,
	CursorType,
	updateCursorType,
} from "@/lib/storage";
import {
	IContextType,
	ScreenshotConfig,
	SystemAudioDaemonConfig,
	TYPE_PROVIDER,
} from "@/types";
import curl2Json from "@bany/curl-to-json";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { enable, disable } from "@tauri-apps/plugin-autostart";
import {
	ReactNode,
	createContext,
	useContext,
	useEffect,
	useState,
} from "react";

const validateAndProcessCurlProviders = (
	providersJson: string,
	providerType: "AI" | "STT",
): TYPE_PROVIDER[] => {
	try {
		const parsed = JSON.parse(providersJson);
		if (!Array.isArray(parsed)) {
			return [];
		}

		return parsed
			.filter((p) => {
				try {
					curl2Json(p.curl);
					return true;
				} catch (e) {
					return false;
				}

				return true;
			})
			.map((p) => {
				const provider = { ...p, isCustom: true };
				if (providerType === "STT" && provider.curl) {
					provider.curl = provider.curl.replace(
						/AUDIO_BASE64/g,
						"AUDIO",
					);
				}
				return provider;
			});
	} catch (e) {
		console.warn(`Failed to parse custom ${providerType} providers`, e);
		return [];
	}
};

/** Keys that must never appear in user-provided variable maps (prototype-pollution prevention). */
const FORBIDDEN_VARIABLE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Returns a typed null-prototype object — safe from prototype-pollution. */
function createEmptyVariablesById(): Record<string, Record<string, string>> {
	return Object.create(null) as Record<string, Record<string, string>>;
}

/**
 * Strips dangerous keys and non-string values from a raw variable map.
 * Returns a clean Record<string, string> safe for storage and use.
 */
function sanitizeProviderVariables(
	rawVariables: Record<string, unknown>,
): Record<string, string> {
	const sanitized: Record<string, string> = Object.create(null);

	for (const [key, value] of Object.entries(rawVariables)) {
		if (!FORBIDDEN_VARIABLE_KEYS.has(key) && typeof value === "string") {
			sanitized[key] = value;
		}
	}

	return sanitized;
}

/**
 * Parses a JSON string of per-provider variable maps from localStorage.
 * Each key is a provider ID, each value is a sanitized variable map.
 * Returns a safe null-proto object on any parse failure.
 */
function parseProviderVariablesById(
	storageValue: string | null,
): Record<string, Record<string, string>> {
	if (!storageValue) return createEmptyVariablesById();

	try {
		const parsed = JSON.parse(storageValue);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return createEmptyVariablesById();
		}

		const sanitizedResult = createEmptyVariablesById();
		for (const [providerId, variables] of Object.entries(parsed)) {
			if (
				!FORBIDDEN_VARIABLE_KEYS.has(providerId) &&
				typeof variables === "object" &&
				variables !== null
			) {
				sanitizedResult[providerId] = sanitizeProviderVariables(
					variables as Record<string, unknown>,
				);
			}
		}
		return sanitizedResult;
	} catch {
		return createEmptyVariablesById();
	}
}

/**
 * Persists a single provider's variables to the per-provider localStorage map.
 * Called on every variable edit and before provider switches, so no data is lost.
 */
function persistProviderVariables(
	storageKey: string,
	providerId: string,
	variables: Record<string, string>,
): void {
	if (!providerId) return;

	const hasValues = Object.values(variables).some((value) => Boolean(value));
	if (!hasValues) return;

	const savedVariablesById = parseProviderVariablesById(
		safeLocalStorage.getItem(storageKey),
	);
	savedVariablesById[providerId] = sanitizeProviderVariables(variables);
	safeLocalStorage.setItem(storageKey, JSON.stringify(savedVariablesById));
}

/**
 * Restores previously-saved variables for a provider.
 * Merges saved values into any incoming keys that are empty,
 * so user-provided values always take precedence.
 */
function restoreSavedProviderVariables(
	storageKey: string,
	providerId: string,
	incomingVariables: Record<string, string>,
): Record<string, string> {
	if (!providerId) return incomingVariables;

	const savedVariablesById = parseProviderVariablesById(
		safeLocalStorage.getItem(storageKey),
	);
	const previouslySaved = savedVariablesById[providerId];
	if (!previouslySaved || Object.keys(previouslySaved).length === 0) {
		return incomingVariables;
	}

	// Merge: saved values fill in empty incoming keys, explicit values win
	const merged = { ...incomingVariables };
	for (const [key, savedValue] of Object.entries(previouslySaved)) {
		if (!merged[key]) {
			merged[key] = savedValue;
		}
	}
	return merged;
}

// Create the context
const AppContext = createContext<IContextType | undefined>(undefined);

// Create the provider component
export const AppProvider = ({ children }: { children: ReactNode }) => {
	const [systemPrompt, setSystemPrompt] = useState<string>(
		safeLocalStorage.getItem(STORAGE_KEYS.SYSTEM_PROMPT) ||
			DEFAULT_SYSTEM_PROMPT,
	);

	// AI Providers
	const [customAiProviders, setCustomAiProviders] = useState<TYPE_PROVIDER[]>(
		[],
	);
	const [selectedAIProvider, setSelectedAIProvider] = useState<{
		provider: string;
		variables: Record<string, string>;
	}>({
		provider: "",
		variables: {},
	});

	// STT Providers
	const [customSttProviders, setCustomSttProviders] = useState<
		TYPE_PROVIDER[]
	>([]);
	const [selectedSttProvider, setSelectedSttProvider] = useState<{
		provider: string;
		variables: Record<string, string>;
	}>({
		provider: "",
		variables: {},
	});

	const [screenshotConfiguration, setScreenshotConfiguration] =
		useState<ScreenshotConfig>({
			mode: "manual",
			autoPrompt: "Analyze this screenshot and provide insights",
			enabled: true,
			// sensible defaults for compression
			compressionEnabled: true,
			compressionQuality: 75,
			compressionMaxDimension: 1600,
		});

	const [systemAudioDaemonConfig, setSystemAudioDaemonConfig] =
		useState<SystemAudioDaemonConfig>({
			enabled: false,
			bufferSeconds: 30,
		});

	// Selected audio devices for the speaker module (real-time capture)
	const [selectedAudioDevices, setSelectedAudioDevices] = useState<{
		input: { id: string; name: string };
		output: { id: string; name: string };
	}>(() => {
		const stored = safeLocalStorage.getItem(
			STORAGE_KEYS.SELECTED_AUDIO_DEVICES,
		);
		if (stored) {
			try {
				return JSON.parse(stored);
			} catch {
				return {
					input: { id: "default", name: "Default" },
					output: { id: "default", name: "Default" },
				};
			}
		}
		return {
			input: { id: "default", name: "Default" },
			output: { id: "default", name: "Default" },
		};
	});

	// Unified Customizable State (initialize from persisted storage)
	const [customizable, setCustomizable] = useState<CustomizableState>(
		getCustomizableState(),
	);
	const [hasActiveLicense, setHasActiveLicense] = useState<boolean>(true);
	const [supportsImages, setSupportsImagesState] = useState<boolean>(() => {
		const stored = safeLocalStorage.getItem(STORAGE_KEYS.SUPPORTS_IMAGES);
		return stored === null ? true : stored === "true";
	});

	// Track whether macOS screen recording permission has been granted (cached across sessions)
	const [
		screenRecordingPermissionGranted,
		setScreenRecordingPermissionGranted,
	] = useState<boolean>(() => {
		const stored = safeLocalStorage.getItem(
			STORAGE_KEYS.SCREEN_RECORDING_GRANTED,
		);
		return stored === "true";
	});

	const setScreenRecordingPermission = (granted: boolean) => {
		setScreenRecordingPermissionGranted(granted);
		safeLocalStorage.setItem(
			STORAGE_KEYS.SCREEN_RECORDING_GRANTED,
			String(granted),
		);
	};

	// On startup, check macOS screen recording permission and cache it (avoid repeated prompting)
	useEffect(() => {
		const checkPermission = async () => {
			try {
				const platform = navigator.platform.toLowerCase();
				if (!platform.includes("mac")) return;
				const { checkScreenRecordingPermission } =
					await import("tauri-plugin-macos-permissions-api");
				const hasPermission = await checkScreenRecordingPermission();
				if (hasPermission) {
					setScreenRecordingPermission(true);
				}
			} catch (err) {
				// ignore failures - plugin may not be available in non-mac builds
				console.debug("Screen recording permission check failed:", err);
			}
		};

		if (!screenRecordingPermissionGranted) {
			checkPermission();
		}
	}, [screenRecordingPermissionGranted]);

	// Wrapper to sync supportsImages to localStorage
	const setSupportsImages = (value: boolean) => {
		setSupportsImagesState(value);
		safeLocalStorage.setItem(STORAGE_KEYS.SUPPORTS_IMAGES, String(value));
	};

	// STT language preference — persisted, defaults to "auto" (provider auto-detect)
	const [sttLanguage, setSttLanguageState] = useState<string>(() => {
		return safeLocalStorage.getItem(STORAGE_KEYS.STT_LANGUAGE) || "auto";
	});

	const setSttLanguage = (language: string) => {
		setSttLanguageState(language);
		safeLocalStorage.setItem(STORAGE_KEYS.STT_LANGUAGE, language);
	};

	// Target language — linked to Response Language setting (single source of truth)
	const [targetLanguage, setTargetLanguageState] = useState<string>(() => {
		const responseSettings = getResponseSettings();
		return RESPONSE_LANGUAGE_TO_ISO[responseSettings.language] || "en";
	});

	const setTargetLanguage = (isoCode: string) => {
		setTargetLanguageState(isoCode);
		// Sync to response settings (the shared source of truth)
		const responseLanguageId = ISO_TO_RESPONSE_LANGUAGE[isoCode];
		if (responseLanguageId) {
			updateResponseLanguage(responseLanguageId);
		}
	};

	// Model speed toggle state (fast/slow) — session-scoped, defaults to "fast"
	const [modelSpeed, setModelSpeed] = useState<"fast" | "slow">("fast");

	// Nyx API State
	const [nyxApiEnabled, setNyxApiEnabledState] = useState<boolean>(
		safeLocalStorage.getItem(STORAGE_KEYS.RUNNINGBORD_API_ENABLED) ===
			"true",
	);

	const getActiveLicenseStatus = async () => {
		setHasActiveLicense(true);
		setNyxApiEnabled(false);
	};

	useEffect(() => {
		const syncLicenseState = async () => {
			try {
				await invoke("set_license_status", {
					hasLicense: hasActiveLicense,
				});

				const config = getShortcutsConfig();
				await invoke("update_shortcuts", { config });
			} catch (error) {
				console.error("Failed to synchronize license state:", error);
			}
		};

		syncLicenseState();

		// On startup, apply saved app-icon visibility to native layer (macOS/Windows/Linux)
		const applySavedAppIconVisibility = async () => {
			try {
				const saved = getCustomizableState();
				await invoke("set_app_icon_visibility", {
					visible: saved.appIcon.isVisible,
				});
			} catch (err) {
				console.debug(
					"Failed to apply saved app icon visibility:",
					err,
				);
			}
		};

		applySavedAppIconVisibility();
	}, [hasActiveLicense]);

	// Function to load AI, STT, system prompt and screenshot config data from storage
	const loadData = () => {
		// Load system prompt
		const savedSystemPrompt = safeLocalStorage.getItem(
			STORAGE_KEYS.SYSTEM_PROMPT,
		);
		if (savedSystemPrompt) {
			setSystemPrompt(savedSystemPrompt || DEFAULT_SYSTEM_PROMPT);
		}

		// Load screenshot configuration
		const savedScreenshotConfig = safeLocalStorage.getItem(
			STORAGE_KEYS.SCREENSHOT_CONFIG,
		);
		if (savedScreenshotConfig) {
			try {
				const parsed = JSON.parse(savedScreenshotConfig);
				if (typeof parsed === "object" && parsed !== null) {
					setScreenshotConfiguration({
						mode: parsed.mode || "manual",
						autoPrompt:
							parsed.autoPrompt ||
							"Analyze this screenshot and provide insights",
						enabled:
							parsed.enabled !== undefined
								? parsed.enabled
								: false,
						// Load compression settings with sensible defaults
						compressionEnabled:
							parsed.compressionEnabled !== undefined
								? parsed.compressionEnabled
								: true,
						compressionQuality:
							parsed.compressionQuality !== undefined
								? parsed.compressionQuality
								: 75,
						compressionMaxDimension:
							parsed.compressionMaxDimension !== undefined
								? parsed.compressionMaxDimension
								: 1600,
					});
				}
			} catch (err) {
				console.warn("Failed to parse screenshot config", err);
			}
		}

		// Load system audio daemon configuration
		const savedSystemAudioConfig = safeLocalStorage.getItem(
			STORAGE_KEYS.SYSTEM_AUDIO_DAEMON_CONFIG,
		);
		if (savedSystemAudioConfig) {
			try {
				const parsed = JSON.parse(savedSystemAudioConfig);
				if (typeof parsed === "object" && parsed !== null) {
					setSystemAudioDaemonConfig({
						enabled: Boolean(parsed.enabled),
						bufferSeconds:
							typeof parsed.bufferSeconds === "number" &&
							parsed.bufferSeconds >= 5 &&
							parsed.bufferSeconds <= 300
								? parsed.bufferSeconds
								: 30,
					});
				}
			} catch (err) {
				console.warn("Failed to parse system audio daemon config", err);
			}
		}

		// Ensure we sync persisted "customizable" settings into state
		try {
			const persistedCustomizable = getCustomizableState();
			setCustomizable(persistedCustomizable);
		} catch (err) {
			console.warn("Failed to load customizable state", err);
		}

		// Check macOS screen recording permission once on startup and cache the result
		(async () => {
			try {
				// Only run on macOS
				const platform = getPlatform();
				if (platform === "macos") {
					try {
						const { checkScreenRecordingPermission } =
							await import("tauri-plugin-macos-permissions-api");
						const granted = await checkScreenRecordingPermission();
						setScreenRecordingPermission(granted);
					} catch (e) {
						// Ignore if plugin is not available or check fails
						console.debug(
							"Screen recording permission check failed:",
							e,
						);
					}
				}
			} catch (e) {
				console.debug(
					"Failed to check screen recording permission on startup:",
					e,
				);
			}
		})();

		// Load custom AI providers
		const savedAi = safeLocalStorage.getItem(
			STORAGE_KEYS.CUSTOM_AI_PROVIDERS,
		);
		let aiList: TYPE_PROVIDER[] = [];
		if (savedAi) {
			aiList = validateAndProcessCurlProviders(savedAi, "AI");
		}
		setCustomAiProviders(aiList);

		// Load custom STT providers
		const savedStt = safeLocalStorage.getItem(
			STORAGE_KEYS.CUSTOM_SPEECH_PROVIDERS,
		);
		let sttList: TYPE_PROVIDER[] = [];
		if (savedStt) {
			sttList = validateAndProcessCurlProviders(savedStt, "STT");
		}
		setCustomSttProviders(sttList);

		// Load selected AI provider
		const savedSelectedAi = safeLocalStorage.getItem(
			STORAGE_KEYS.SELECTED_AI_PROVIDER,
		);
		if (savedSelectedAi) {
			setSelectedAIProvider(JSON.parse(savedSelectedAi));
		}

		// Load selected STT provider
		const savedSelectedStt = safeLocalStorage.getItem(
			STORAGE_KEYS.SELECTED_STT_PROVIDER,
		);
		if (savedSelectedStt) {
			setSelectedSttProvider(JSON.parse(savedSelectedStt));
		}

		// Load customizable state
		const customizableState = getCustomizableState();
		setCustomizable(customizableState);

		updateCursor(customizableState.cursor.type || "invisible");

		const stored = safeLocalStorage.getItem(STORAGE_KEYS.CUSTOMIZABLE);
		if (!stored) {
			// save the default state
			setCustomizableState(customizableState);
		} else {
			// check if we need to update the schema
			try {
				const parsed = JSON.parse(stored);
				if (!parsed.autostart) {
					// save the merged state with new autostart property
					setCustomizableState(customizableState);
					updateCursor(customizableState.cursor.type || "invisible");
				}
			} catch (error) {
				console.debug(
					"Failed to check customizable state schema:",
					error,
				);
			}
		}

		// Load Nyx API enabled state
		const savedNyxApiEnabled = safeLocalStorage.getItem(
			STORAGE_KEYS.RUNNINGBORD_API_ENABLED,
		);
		if (savedNyxApiEnabled !== null) {
			setNyxApiEnabledState(savedNyxApiEnabled === "true");
		}

		// Load STT language
		const savedSttLanguage = safeLocalStorage.getItem(STORAGE_KEYS.STT_LANGUAGE);
		if (savedSttLanguage) {
			setSttLanguageState(savedSttLanguage);
		}

		// Sync target language from response settings
		const currentResponseSettings = getResponseSettings();
		const isoFromResponse = RESPONSE_LANGUAGE_TO_ISO[currentResponseSettings.language] || "en";
		setTargetLanguageState(isoFromResponse);
	};

	const updateCursor = (type: CursorType | undefined) => {
		try {
			const currentWindow = getCurrentWindow();
			const platform = getPlatform();
			// For Linux, always use default cursor
			if (platform === "linux") {
				document.documentElement.style.setProperty(
					"--cursor-type",
					"default",
				);
				return;
			}
			const windowLabel = currentWindow.label;

			if (windowLabel === "dashboard") {
				// For dashboard, always use default cursor
				document.documentElement.style.setProperty(
					"--cursor-type",
					"default",
				);
				return;
			}

			// For overlay windows (main, capture-overlay-*)
			const safeType = type || "invisible";
			const cursorValue = type === "invisible" ? "none" : safeType;
			document.documentElement.style.setProperty(
				"--cursor-type",
				cursorValue,
			);
		} catch (error) {
			document.documentElement.style.setProperty(
				"--cursor-type",
				"default",
			);
		}
	};

	// Load data on mount
	useEffect(() => {
		const initializeApp = async () => {
			// Load license and data
			await getActiveLicenseStatus();

		};
		// Load data
		loadData();
		initializeApp();
	}, []);

	// Handle customizable settings on state changes
	useEffect(() => {
		const applyCustomizableSettings = async () => {
			try {
				await Promise.all([
					invoke("set_app_icon_visibility", {
						visible: customizable.appIcon.isVisible,
					}),
					invoke("set_always_on_top", {
						enabled: customizable.alwaysOnTop.isEnabled,
					}),
				]);
			} catch (error) {
				console.error("Failed to apply customizable settings:", error);
			}
		};

		applyCustomizableSettings();
	}, [customizable]);

	useEffect(() => {
		const initializeAutostart = async () => {
			try {
				const autostartInitialized = safeLocalStorage.getItem(
					STORAGE_KEYS.AUTOSTART_INITIALIZED,
				);

				// Only apply autostart on the very first launch
				if (!autostartInitialized) {
					const autostartEnabled =
						customizable?.autostart?.isEnabled ?? true;

					if (autostartEnabled) {
						await enable();
					} else {
						await disable();
					}

					// Mark as initialized so this never runs again
					safeLocalStorage.setItem(
						STORAGE_KEYS.AUTOSTART_INITIALIZED,
						"true",
					);
				}
			} catch (error) {
				console.debug("Autostart initialization skipped:", error);
			}
		};

		initializeAutostart();
	}, []);

	// Listen for app icon hide/show events when window is toggled
	useEffect(() => {
		const handleAppIconVisibility = async (isVisible: boolean) => {
			try {
				await invoke("set_app_icon_visibility", { visible: isVisible });
			} catch (error) {
				console.error("Failed to set app icon visibility:", error);
			}
		};

		const unlistenHide = listen("handle-app-icon-on-hide", async () => {
			const currentState = getCustomizableState();
			// Only hide app icon if user has set it to hide mode
			if (!currentState.appIcon.isVisible) {
				await handleAppIconVisibility(false);
			}
		});

		const unlistenShow = listen("handle-app-icon-on-show", async () => {
			// Always show app icon when window is shown, regardless of user setting
			await handleAppIconVisibility(true);
		});

		return () => {
			unlistenHide.then((fn) => fn());
			unlistenShow.then((fn) => fn());
		};
	}, []);

	// Listen to storage events for real-time sync (e.g., multi-tab)
	useEffect(() => {
		const handleStorageChange = (e: StorageEvent) => {
			// Sync supportsImages across windows
			if (e.key === STORAGE_KEYS.SUPPORTS_IMAGES && e.newValue !== null) {
				setSupportsImagesState(e.newValue === "true");
			}

			if (
				e.key === STORAGE_KEYS.CUSTOM_AI_PROVIDERS ||
				e.key === STORAGE_KEYS.SELECTED_AI_PROVIDER ||
				e.key === STORAGE_KEYS.CUSTOM_SPEECH_PROVIDERS ||
				e.key === STORAGE_KEYS.SELECTED_STT_PROVIDER ||
				e.key === STORAGE_KEYS.SYSTEM_PROMPT ||
				e.key === STORAGE_KEYS.SCREENSHOT_CONFIG ||
				e.key === STORAGE_KEYS.SYSTEM_AUDIO_DAEMON_CONFIG ||
				e.key === STORAGE_KEYS.CUSTOMIZABLE ||
				e.key === STORAGE_KEYS.STT_LANGUAGE ||
				e.key === STORAGE_KEYS.RESPONSE_SETTINGS
			) {
				loadData();
			}
		};
		window.addEventListener("storage", handleStorageChange);
		return () => window.removeEventListener("storage", handleStorageChange);
	}, []);

	// Check if the current AI provider/model supports images
	useEffect(() => {
		const checkImageSupport = async () => {
			if (nyxApiEnabled) {
				// For Nyx API, check the selected model's modality
				try {
					const storage = await invoke<{
						selected_nyx_model?: string;
					}>("secure_storage_get");

					if (storage.selected_nyx_model) {
						const model = JSON.parse(storage.selected_nyx_model);
						const hasImageSupport =
							model.modality?.includes("image") ?? false;
						setSupportsImages(hasImageSupport);
					} else {
						// No model selected, assume no image support
						setSupportsImages(false);
					}
				} catch (error) {
					setSupportsImages(false);
				}
			} else {
				// For custom AI providers, check if curl contains {{IMAGE}}
				const provider = allAiProviders.find(
					(p) => p.id === selectedAIProvider.provider,
				);
				if (provider) {
					const hasImageSupport =
						provider.curl?.includes("{{IMAGE}}") ?? false;
					setSupportsImages(hasImageSupport);
				} else {
					setSupportsImages(true);
				}
			}
		};

		checkImageSupport();
	}, [nyxApiEnabled, selectedAIProvider.provider]);

	// Sync selected AI to localStorage
	useEffect(() => {
		if (selectedAIProvider.provider) {
			safeLocalStorage.setItem(
				STORAGE_KEYS.SELECTED_AI_PROVIDER,
				JSON.stringify(selectedAIProvider),
			);
		}
	}, [selectedAIProvider]);

	// Sync selected STT to localStorage
	useEffect(() => {
		if (selectedSttProvider.provider) {
			safeLocalStorage.setItem(
				STORAGE_KEYS.SELECTED_STT_PROVIDER,
				JSON.stringify(selectedSttProvider),
			);
		}
	}, [selectedSttProvider]);

	// Persist AI provider variables to per-provider map on every edit
	useEffect(() => {
		persistProviderVariables(
			STORAGE_KEYS.AI_PROVIDER_VARIABLES_BY_ID,
			selectedAIProvider.provider,
			selectedAIProvider.variables,
		);
	}, [selectedAIProvider.provider, selectedAIProvider.variables]);

	// Persist STT provider variables to per-provider map on every edit
	useEffect(() => {
		persistProviderVariables(
			STORAGE_KEYS.STT_PROVIDER_VARIABLES_BY_ID,
			selectedSttProvider.provider,
			selectedSttProvider.variables,
		);
	}, [selectedSttProvider.provider, selectedSttProvider.variables]);

	// Persist system audio daemon config
	useEffect(() => {
		safeLocalStorage.setItem(
			STORAGE_KEYS.SYSTEM_AUDIO_DAEMON_CONFIG,
			JSON.stringify(systemAudioDaemonConfig),
		);
	}, [systemAudioDaemonConfig]);

	// Persist selected audio devices
	useEffect(() => {
		safeLocalStorage.setItem(
			STORAGE_KEYS.SELECTED_AUDIO_DEVICES,
			JSON.stringify(selectedAudioDevices),
		);
	}, [selectedAudioDevices]);

	// Apply system audio daemon to backend (start/stop)
	useEffect(() => {
		const apply = async () => {
			try {
				if (systemAudioDaemonConfig.enabled) {
					await invoke("system_audio_start", {
						bufferSeconds: systemAudioDaemonConfig.bufferSeconds,
					});
				} else {
					await invoke("system_audio_stop");
				}
			} catch (e) {
				console.debug("System audio daemon sync failed:", e);
			}
		};
		apply();
	}, [
		systemAudioDaemonConfig.enabled,
		systemAudioDaemonConfig.bufferSeconds,
	]);

	// Computed all AI providers
	const allAiProviders: TYPE_PROVIDER[] = [
		...AI_PROVIDERS,
		...customAiProviders,
	];

	// Computed all STT providers
	const allSttProviders: TYPE_PROVIDER[] = [
		...SPEECH_TO_TEXT_PROVIDERS,
		...customSttProviders,
	];

	const onSetSelectedAIProvider = ({
		provider,
		variables,
	}: {
		provider: string;
		variables: Record<string, string>;
	}) => {
		if (provider && !allAiProviders.some((p) => p.id === provider)) {
			console.warn(`Invalid AI provider ID: ${provider}`);
			return;
		}

		// Update supportsImages immediately when provider changes
		if (!nyxApiEnabled) {
			const selectedProvider = allAiProviders.find(
				(p) => p.id === provider,
			);
			if (selectedProvider) {
				const hasImageSupport =
					selectedProvider.curl?.includes("{{IMAGE}}") ?? false;
				setSupportsImages(hasImageSupport);
			} else {
				setSupportsImages(true);
			}
		}

		// Save current provider's variables before switching
		persistProviderVariables(
			STORAGE_KEYS.AI_PROVIDER_VARIABLES_BY_ID,
			selectedAIProvider.provider,
			selectedAIProvider.variables,
		);

		// Restore saved variables for the new provider (merges into empty keys)
		const restoredVariables = restoreSavedProviderVariables(
			STORAGE_KEYS.AI_PROVIDER_VARIABLES_BY_ID,
			provider,
			variables,
		);

		setSelectedAIProvider((prev) => ({
			...prev,
			provider,
			variables: restoredVariables,
		}));
	};

	// Setter for selected STT with validation
	const onSetSelectedSttProvider = ({
		provider,
		variables,
	}: {
		provider: string;
		variables: Record<string, string>;
	}) => {
		if (provider && !allSttProviders.some((p) => p.id === provider)) {
			console.warn(`Invalid STT provider ID: ${provider}`);
			return;
		}

		// Save current provider's variables before switching
		persistProviderVariables(
			STORAGE_KEYS.STT_PROVIDER_VARIABLES_BY_ID,
			selectedSttProvider.provider,
			selectedSttProvider.variables,
		);

		// Restore saved variables for the new provider (merges into empty keys)
		const restoredVariables = restoreSavedProviderVariables(
			STORAGE_KEYS.STT_PROVIDER_VARIABLES_BY_ID,
			provider,
			variables,
		);

		setSelectedSttProvider((prev) => ({
			...prev,
			provider,
			variables: restoredVariables,
		}));
	};

	// Toggle handlers
	const toggleAppIconVisibility = async (isVisible: boolean) => {
		const previousState = getCustomizableState();
		const newState = updateAppIconVisibility(isVisible);

		// Optimistically update UI so the toggle feels responsive
		setCustomizable(newState);

		try {
			await invoke("set_app_icon_visibility", { visible: isVisible });
			loadData();
		} catch (error) {
			console.error("Failed to toggle app icon visibility:", error);

			// Revert UI and persisted state on failure
			setCustomizable(previousState);
			setCustomizableState(previousState);

			// Notify user so they know to check system settings or restart the app
			try {
				window.alert(
					"Failed to change app icon visibility. Please check system settings and try restarting the app.",
				);
			} catch (e) {
				// ignore
			}
		}
	};

	const toggleAlwaysOnTop = async (isEnabled: boolean) => {
		const newState = updateAlwaysOnTop(isEnabled);
		setCustomizable(newState);
		try {
			await invoke("set_always_on_top", { enabled: isEnabled });
			loadData();
		} catch (error) {
			console.error("Failed to toggle always on top:", error);
		}
	};

	const toggleAutostart = async (isEnabled: boolean) => {
		const newState = updateAutostart(isEnabled);
		setCustomizable(newState);
		try {
			if (isEnabled) {
				await enable();
			} else {
				await disable();
			}
			loadData();
		} catch (error) {
			console.error("Failed to toggle autostart:", error);
			const revertedState = updateAutostart(!isEnabled);
			setCustomizable(revertedState);
		}
	};

	const setCursorType = (type: CursorType) => {
		setCustomizable((prev) => ({ ...prev, cursor: { type } }));
		updateCursor(type);
		updateCursorType(type);
		loadData();
	};

	const setNyxApiEnabled = async (enabled: boolean) => {
		setNyxApiEnabledState(enabled);
		safeLocalStorage.setItem(
			STORAGE_KEYS.RUNNINGBORD_API_ENABLED,
			String(enabled),
		);

		if (enabled) {
			try {
				const storage = await invoke<{
					selected_nyx_model?: string;
				}>("secure_storage_get");

				if (storage.selected_nyx_model) {
					const model = JSON.parse(storage.selected_nyx_model);
					const hasImageSupport =
						model.modality?.includes("image") ?? false;
					setSupportsImages(hasImageSupport);
				} else {
					// No model selected, assume no image support
					setSupportsImages(false);
				}
			} catch (error) {
				console.debug(
					"Failed to check Nyx model image support:",
					error,
				);
				setSupportsImages(false);
			}
		} else {
			// Switching to regular provider - check if curl contains {{IMAGE}}
			const provider = allAiProviders.find(
				(p) => p.id === selectedAIProvider.provider,
			);
			if (provider) {
				const hasImageSupport =
					provider.curl?.includes("{{IMAGE}}") ?? false;
				setSupportsImages(hasImageSupport);
			} else {
				setSupportsImages(true);
			}
		}

		loadData();
	};

	// Create the context value (extend IContextType accordingly)
	const value: IContextType = {
		systemPrompt,
		setSystemPrompt,
		allAiProviders,
		customAiProviders,
		selectedAIProvider,
		onSetSelectedAIProvider,
		allSttProviders,
		customSttProviders,
		selectedSttProvider,
		onSetSelectedSttProvider,
		screenshotConfiguration,
		setScreenshotConfiguration,
		systemAudioDaemonConfig,
		setSystemAudioDaemonConfig,
		selectedAudioDevices,
		setSelectedAudioDevices,
		customizable,
		toggleAppIconVisibility,
		toggleAlwaysOnTop,
		toggleAutostart,
		loadData,
		nyxApiEnabled,
		setNyxApiEnabled,
		hasActiveLicense,
		setHasActiveLicense,
		getActiveLicenseStatus,
		setCursorType,
		supportsImages,
		setSupportsImages,
		screenRecordingPermissionGranted,
		setScreenRecordingPermission,
		sttLanguage,
		setSttLanguage,
		targetLanguage,
		setTargetLanguage,
		modelSpeed,
		setModelSpeed,
	};

	return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

// Create a hook to access the context
export const useApp = () => {
	const context = useContext(AppContext);

	if (!context) {
		throw new Error("useApp must be used within a AppProvider");
	}

	return context;
};
